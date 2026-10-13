/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The laddered-mode guard against the REAL AcpSession / SessionLifecycle /
 * PromptExecutor - only the agent process is faked. The Claude bridge starts
 * every session in the user's `defaultMode` (`auto` here), and SessionLifecycle
 * reports that mode BEFORE the session is active. The session must survive
 * that, get clamped, and send its first prompt only in the clamped mode, with
 * writes refused until the mode is confirmed - at start, after a suspend /
 * resume, and on a mid-turn mode change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';
import { AcpAgentV2 } from '@process/acp/compat/AcpAgentV2';
import type { ProtocolHandlers } from '@process/acp/types';
import { ProcessConfig } from '@process/utils/initStorage';

const PACK = 'pack-warrior-estimator';

type Call = { method: string; mode?: string };

class FakeClaudeAgent {
  mode = 'auto';
  calls: Call[] = [];
  handlers!: ProtocolHandlers;
  /** When set, the next prompt waits on this before finishing. */
  holdPrompt?: Promise<void>;
  refuseModes = new Set<string>();
  private disconnect?: (info: unknown) => void;

  get lifecycleSnapshot() {
    return { pid: 1, startedAt: 0, alive: true } as never;
  }
  async start() {
    this.calls.push({ method: 'initialize' });
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: '@agentclientprotocol/claude-agent-acp', version: '0.74.0' },
    } as never;
  }
  private sessionResult() {
    // The bridge always (re)starts in the user's defaultMode.
    this.mode = 'auto';
    return {
      sessionId: 's-1',
      modes: {
        currentModeId: this.mode,
        availableModes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'].map((id) => ({
          id,
          name: id,
        })),
      },
    } as never;
  }
  async createSession() {
    this.calls.push({ method: 'session/new', mode: 'auto' });
    return this.sessionResult();
  }
  async loadSession() {
    this.calls.push({ method: 'session/load', mode: 'auto' });
    return this.sessionResult();
  }
  async forkSession() {
    return { sessionId: 'f' } as never;
  }
  async prompt() {
    this.calls.push({ method: 'session/prompt', mode: this.mode });
    if (this.holdPrompt) await this.holdPrompt;
    return { stopReason: 'end_turn' } as never;
  }
  async cancel() {}
  async closeSession() {}
  async setModel() {}
  async setMode(_sessionId: string, modeId: string) {
    this.calls.push({ method: 'session/set_mode', mode: modeId });
    if (this.refuseModes.has(modeId)) throw new Error(`mode ${modeId} refused`);
    this.mode = modeId;
  }
  async setConfigOption() {}
  async extMethod() {
    return {};
  }
  async authenticate() {
    return {};
  }
  onDisconnect(handler: (info: unknown) => void) {
    this.disconnect = handler;
  }
  async close() {}
  /** The bridge switching mode on its own (e.g. a rebuilt query). */
  driftTo(modeId: string) {
    this.mode = modeId;
    this.handlers.onSessionUpdate({
      sessionId: 's-1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
    } as SessionNotification);
  }
  promptModes() {
    return this.calls.filter((c) => c.method === 'session/prompt').map((c) => c.mode);
  }
}

let fake: FakeClaudeAgent;

vi.mock('@process/acp/compat/LegacyConnectorFactory', () => ({
  LegacyConnectorFactory: class {
    create(_config: unknown, handlers: ProtocolHandlers) {
      fake.handlers = handlers;
      return fake;
    }
  },
}));
vi.mock('@process/acp/compat/typeBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@process/acp/compat/typeBridge')>()),
  loadAuthCredentials: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@process/services/mcpServices/runtimeMcpServers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@process/services/mcpServices/runtimeMcpServers')>()),
  loadRuntimeMcpServers: vi.fn(async () => []),
}));
vi.mock('@process/services/mcpServices/McpService', () => ({
  mcpService: { attachOAuthTokens: vi.fn(async (servers: unknown) => servers) },
}));
vi.mock('@/process/team/prompts/teamGuideCapability', () => ({ shouldInjectTeamGuideMcp: async () => false }));
vi.mock('@process/services/jarvis/approvalsPath', () => ({
  resolveApprovalsLogPath: () => '/tmp/jarvis-real-session-approvals.jsonl',
}));
vi.mock('@process/services/jarvis/approvalsLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@process/services/jarvis/approvalsLog')>()),
  appendApprovalTo: vi.fn(),
}));
vi.mock('@process/services/jarvis/hardFloor', () => ({ readHardFloorKeywords: () => [] }));
// The skill plugin is built on disk; its own tests cover it.
vi.mock('@process/services/jarvis/ladderedSkillPlugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@process/services/jarvis/ladderedSkillPlugin')>()),
  buildLadderedSkillPlugin: async () => undefined,
}));

const editRequest = (callId: string): RequestPermissionRequest => ({
  sessionId: 's-1',
  toolCall: { toolCallId: callId, title: 'Write proposal.md', kind: 'edit' },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ],
});

/** Ask the REAL session's permission path; resolves to the chosen option, or 'held' when it went to a person. */
async function permissionFor(callId: string): Promise<string> {
  const pending = fake.handlers.onRequestPermission(editRequest(callId));
  const winner = await Promise.race([
    pending.then((r) => (r.outcome.outcome === 'selected' ? r.outcome.optionId : 'cancelled')),
    new Promise<string>((resolve) => setTimeout(() => resolve('held'), 20)),
  ]);
  return winner;
}

async function startLaddered(rung: number, sessionMode?: string) {
  vi.spyOn(ProcessConfig, 'get').mockImplementation((async (key: string) =>
    key === 'agents.autonomy' ? { [`custom:${PACK}`]: rung } : undefined) as never);
  vi.spyOn(ProcessConfig, 'set').mockResolvedValue(undefined as never);
  const agent = new AcpAgentV2({
    id: `conv-${rung}`,
    backend: 'claude',
    workingDir: '/tmp',
    onStreamEvent: vi.fn(),
    onSignalEvent: vi.fn(),
    extra: { backend: 'claude', customAgentId: PACK, ...(sessionMode ? { sessionMode } : {}) },
  });
  await agent.start();
  return agent;
}

const waitFor = (check: () => boolean) =>
  vi.waitFor(
    () => {
      if (!check()) throw new Error('not yet');
    },
    { timeout: 2000, interval: 5 }
  );

describe('laddered mode guard - real AcpSession', () => {
  beforeEach(() => {
    fake = new FakeClaudeAgent();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [2, undefined, 'default'],
    [3, undefined, 'default'],
    [3, 'bypassPermissions', 'default'], // autoGuarded -> the bridge's `default`
  ])(
    'rung %i (requested %s): survives a start in `auto`, clamps, prompts only in %s, refuses writes until confirmed',
    async (rung, sessionMode, expected) => {
      const agent = await startLaddered(rung, sessionMode);
      // Survived start-up: not killed, no error.
      expect((agent as unknown as { session: { status: string } }).session.status).toBe('active');
      expect(fake.calls.filter((c) => c.method === 'initialize')).toHaveLength(1);
      // Not yet confirmed by the strict guard: writes refused.
      expect(await permissionFor('w-1')).toBe('reject');

      const result = await agent.sendMessage({ content: 'hi' });
      expect(result.success).toBe(true);
      expect(fake.promptModes()).toEqual([expected]);
      // The guard applied the clamp right before the prompt.
      const lastSetMode = fake.calls.map((c) => c.method).lastIndexOf('session/set_mode');
      expect(lastSetMode).toBeLessThan(fake.calls.findIndex((c) => c.method === 'session/prompt'));

      // Confirmed now: a write follows the rung (held at 2, normal flow at 3).
      expect(await permissionFor('w-2')).toBe('held');
    }
  );

  it('suspended -> resume: the queued message is not lost and runs in the clamped mode', async () => {
    const agent = await startLaddered(2);
    await agent.sendMessage({ content: 'first' });
    const session = (agent as unknown as { session: { suspend(): Promise<void>; status: string } }).session;
    await session.suspend();
    expect(session.status).toBe('suspended');

    const result = await agent.sendMessage({ content: 'second' });
    expect(result.success).toBe(true);
    await waitFor(() => fake.promptModes().length === 2);
    expect(fake.calls.some((c) => c.method === 'session/load' || c.method === 'session/new')).toBe(true);
    expect(fake.promptModes()).toEqual(['default', 'default']);
    expect(session.status).not.toBe('error');
  });

  it('a mid-turn mode change is re-clamped immediately; writes are refused until it is confirmed', async () => {
    const agent = await startLaddered(2);
    let finishTurn!: () => void;
    fake.holdPrompt = new Promise<void>((r) => (finishTurn = r));
    let releaseSetMode!: () => void;
    const turn = agent.sendMessage({ content: 'long task' });
    await waitFor(() => fake.promptModes().length === 1);

    // Make the re-clamp observable: the agent takes a moment to accept it.
    const realSetMode = fake.setMode.bind(fake);
    fake.setMode = async (sid: string, modeId: string) => {
      await new Promise<void>((r) => (releaseSetMode = r));
      return realSetMode(sid, modeId);
    };
    fake.driftTo('auto');
    expect(await permissionFor('w-mid')).toBe('reject'); // refused while unconfirmed
    await waitFor(() => typeof releaseSetMode === 'function');
    releaseSetMode();
    await waitFor(() => fake.mode === 'default');
    expect(await permissionFor('w-after')).toBe('held'); // confirmed again

    finishTurn();
    expect((await turn).success).toBe(true);
    const session = (agent as unknown as { session: { status: string } }).session;
    expect(session.status).toBe('active');
  });

  it('a definite refusal of the clamped mode fails closed: no prompt, session in error', async () => {
    fake.refuseModes.add('default');
    const agent = await startLaddered(2);
    const result = await agent.sendMessage({ content: 'hi' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/did not accept session mode "default"/);
    expect(fake.promptModes()).toEqual([]);
  });
});
