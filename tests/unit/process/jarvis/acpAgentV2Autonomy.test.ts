/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AcpAgentV2 is the LIVE ACP path (AcpAgentManager constructs it for every
 * chat, channel, cron and team run). These tests pin that a pack agent with a
 * configured rung gets all three enforcement points from it - shimmed
 * connectors, the permission gate and the mode clamp - and that an agent with
 * no configured rung gets none of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpAgentV2 } from '@process/acp/compat/AcpAgentV2';
import type { OldAcpAgentConfig } from '@process/acp/compat/typeBridge';
import type { AgentConfig, SessionCallbacks } from '@process/acp/types';
import type { SessionOptions } from '@process/acp/session/AcpSession';
import { loadRuntimeMcpServers } from '@process/services/mcpServices/runtimeMcpServers';
import { TOOL_FILTER_SCRIPT } from '@process/services/mcpServices/builtinMcpRuntime';
import { resetAutonomyRungCache } from '@process/services/jarvis/sessionAutonomy';
import { ProcessConfig } from '@process/utils/initStorage';
import type { IMcpServer } from '@/common/config/storage';

let capturedConfig: AgentConfig;
let capturedCallbacks: SessionCallbacks;
let capturedOptions: SessionOptions | undefined;
const sessionSetMode = vi.fn();
const sessionConfirmMode = vi.fn();
const sessionSendMessage = vi.fn();
const sessionStop = vi.fn();

vi.mock('@process/acp/session/AcpSession', () => ({
  AcpSession: class {
    constructor(config: AgentConfig, _f: unknown, callbacks: SessionCallbacks, options?: SessionOptions) {
      capturedConfig = config;
      capturedCallbacks = callbacks;
      capturedOptions = options;
    }
    start = vi.fn(() => setTimeout(() => capturedCallbacks.onStatusChange('active'), 0));
    stop = sessionStop;
    setMode = sessionSetMode;
    confirmMode = sessionConfirmMode;
    sendMessage = sessionSendMessage;
    get status() {
      return 'idle';
    }
    get sessionId() {
      return null;
    }
  },
}));
vi.mock('@process/acp/compat/LegacyConnectorFactory', () => ({ LegacyConnectorFactory: vi.fn() }));
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
vi.mock('@process/services/jarvis/approvalsPath', () => ({
  resolveApprovalsLogPath: () => '/data/jarvis/approvals.jsonl',
}));
vi.mock('@process/services/jarvis/hardFloor', () => ({ readHardFloorKeywords: () => ['wire'] }));

const PACK = 'pack-warrior-estimator';

const ghl: IMcpServer = {
  id: 'ghl',
  name: 'warrior-ghl',
  enabled: true,
  source: 'custom',
  transport: { type: 'stdio', command: '/usr/bin/ghl-mcp', args: [] },
  originalJson: '{}',
  createdAt: 1,
  updatedAt: 1,
} as IMcpServer;

function stubStorage(rungs: Record<string, number> | 'throw') {
  vi.spyOn(ProcessConfig, 'get').mockImplementation((async (key: string) => {
    if (key === 'agents.autonomy') {
      if (rungs === 'throw') throw new Error('store unreadable');
      return rungs;
    }
    if (key === 'acp.cachedInitializeResult') {
      return { claude: { capabilities: { mcpCapabilities: { stdio: true, http: true, sse: true } } } };
    }
    return undefined;
  }) as never);
}

async function startAgent(extra: Partial<NonNullable<OldAcpAgentConfig['extra']>> = {}): Promise<AcpAgentV2> {
  const agent = new AcpAgentV2({
    id: 'conv-1',
    backend: 'claude',
    workingDir: '/workspace',
    onStreamEvent: vi.fn(),
    onSignalEvent: vi.fn(),
    extra: { backend: 'claude', ...extra },
  });
  await agent.start();
  return agent;
}

describe('AcpAgentV2 - JARVIS autonomy on the live path', () => {
  beforeEach(() => {
    vi.mocked(loadRuntimeMcpServers).mockResolvedValue([ghl]);
    sessionSetMode.mockReset();
    sessionConfirmMode.mockReset().mockResolvedValue('default');
    sessionSendMessage.mockReset().mockResolvedValue(undefined);
    sessionStop.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a pack agent at rung 2: shimmed connectors, a permission gate, bypass clamped', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    const agent = await startAgent({ customAgentId: PACK, sessionMode: 'bypassPermissions', yoloMode: true });

    const server = capturedConfig.mcpServers?.find((s) => s.name === 'warrior-ghl') as { args: string[] };
    expect(server.args[0]).toContain(TOOL_FILTER_SCRIPT);
    expect(server.args).toEqual(
      expect.arrayContaining([
        '--rung',
        '2',
        '--agent',
        `custom:${PACK}`,
        '--log',
        '/data/jarvis/approvals.jsonl',
        '--floor',
        'wire',
      ])
    );

    expect(capturedOptions?.permissionGate).toBeDefined();
    // The session never starts in a bypass mode and never carries blanket yolo.
    expect(capturedConfig.initialDesired?.mode).toBe('default');
    expect(capturedConfig.yoloMode).toBe(false);
    expect(capturedOptions?.initialDesired?.mode).toBe('default');
    // Claude Code's own allow rules / defaultMode / hooks are not loaded.
    expect(capturedConfig.sessionMeta).toEqual({ claudeCode: { options: { settingSources: ['project'] } } });

    // A later switch into bypass is refused and the session re-asserted to default.
    const result = await agent.setMode('bypassPermissions');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/rung 2/);
    expect(result.effectiveMode).toBe('default');
    expect(sessionSetMode).toHaveBeenCalledWith('default');
    // The cron path's enableYoloMode goes through the same clamp.
    sessionSetMode.mockReset();
    await agent.enableYoloMode();
    expect(sessionSetMode).not.toHaveBeenCalledWith('autoGuarded');
    expect(sessionSetMode).not.toHaveBeenCalledWith('bypassPermissions');
  });

  it('a pack agent at rung 4 in Autopilot runs guarded full-auto, so the floor still sees its calls', async () => {
    stubStorage({ [`custom:${PACK}`]: 4 });
    const agent = await startAgent({ customAgentId: PACK, sessionMode: 'bypassPermissions' });
    expect(capturedConfig.initialDesired?.mode).toBe('autoGuarded');
    // Not awaited: the mocked session never answers the mode op.
    void agent.setMode('bypassPermissions');
    expect(sessionSetMode).toHaveBeenCalledWith('autoGuarded');
    expect(sessionSetMode).not.toHaveBeenCalledWith('bypassPermissions');
  });

  it('forwards autonomyHold on the acp_permission signal', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    const onSignalEvent = vi.fn();
    const agent = new AcpAgentV2({
      id: 'conv-2',
      backend: 'claude',
      workingDir: '/workspace',
      onStreamEvent: vi.fn(),
      onSignalEvent,
      extra: { backend: 'claude', customAgentId: PACK },
    });
    await agent.start();
    capturedCallbacks.onPermissionRequest({
      callId: 'c1',
      title: 'Write a.md',
      description: '',
      kind: 'edit',
      options: [{ optionId: 'allow', label: 'Allow', kind: 'allow_once' }],
      autonomyHold: true,
    });
    expect(onSignalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'acp_permission', data: expect.objectContaining({ autonomyHold: true }) })
    );
  });

  it('an agent with NO configured rung keeps today’s behaviour', async () => {
    stubStorage({ [`custom:${PACK}`]: 1 });
    const agent = await startAgent({ sessionMode: 'bypassPermissions', yoloMode: true });

    const server = capturedConfig.mcpServers?.find((s) => s.name === 'warrior-ghl') as { args: string[] };
    expect(server.args.join(' ')).not.toContain(TOOL_FILTER_SCRIPT);
    expect(capturedOptions?.permissionGate).toBeUndefined();
    expect(capturedConfig.initialDesired?.mode).toBe('bypassPermissions');
    expect(capturedConfig.yoloMode).toBe(true);
    expect(capturedConfig.sessionMeta).toBeUndefined();
    void agent.setMode('bypassPermissions');
    expect(sessionSetMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('an unreadable rung store with no prior copy runs unladdered (plain chats unaffected)', async () => {
    resetAutonomyRungCache();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubStorage('throw');
    await startAgent({ customAgentId: PACK });
    const server = capturedConfig.mcpServers?.find((s) => s.name === 'warrior-ghl') as { args: string[] };
    expect(server.args).not.toContain('--rung');
    expect(capturedOptions?.permissionGate).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('an unreadable rung store reuses the last copy read successfully', async () => {
    resetAutonomyRungCache();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubStorage({ [`custom:${PACK}`]: 1 });
    await startAgent({ customAgentId: PACK });
    stubStorage('throw');
    await startAgent({ customAgentId: PACK });
    const server = capturedConfig.mcpServers?.find((s) => s.name === 'warrior-ghl') as { args: string[] };
    expect(server.args[server.args.indexOf('--rung') + 1]).toBe('1');
    // A plain chat stays off the ladder on the cached copy too.
    await startAgent({});
    expect(capturedOptions?.permissionGate).toBeUndefined();
  });

  it('every laddered turn starts in a CONFIRMED mode within the rung', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    const agent = await startAgent({ customAgentId: PACK, sessionMode: 'bypassPermissions' });
    const result = await agent.sendMessage({ content: 'hi' });
    expect(result.success).toBe(true);
    expect(sessionConfirmMode).toHaveBeenCalledWith('default');
    expect(sessionConfirmMode.mock.invocationCallOrder[0]).toBeLessThan(sessionSendMessage.mock.invocationCallOrder[0]);
  });

  it('fails CLOSED when the agent will not accept the laddered mode: no turn, session stopped', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    sessionConfirmMode.mockRejectedValue(new Error('Invalid params'));
    const agent = await startAgent({ customAgentId: PACK });
    const result = await agent.sendMessage({ content: 'hi' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/did not accept session mode "default"/);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(sessionStop).toHaveBeenCalled();
  });

  it('re-applies the laddered mode when the agent reports a mode outside the rung, refusing writes meanwhile', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    let release!: (v: string) => void;
    sessionConfirmMode.mockImplementation(() => new Promise<string>((r) => (release = r)));
    await startAgent({ customAgentId: PACK });
    const gate = capturedOptions!.permissionGate!;
    const write = {
      sessionId: 's',
      toolCall: { toolCallId: 'c', title: 'Write a.md', kind: 'edit' as const },
      options: [
        { optionId: 'a', name: 'Allow', kind: 'allow_once' as const },
        { optionId: 'r', name: 'Reject', kind: 'reject_once' as const },
      ],
    };
    // e.g. the bridge rebuilt its query from the user's defaultMode "auto".
    capturedCallbacks.onModeUpdate({ currentModeId: 'auto', availableModes: [] } as never);
    expect(sessionConfirmMode).toHaveBeenCalledWith('default');
    expect(gate.check(write).action).toBe('deny');
    release('default');
    await new Promise((r) => setTimeout(r, 0));
    expect(gate.check(write).action).toBe('hold');
  });

  it('a non-laddered chat never confirms modes before a turn', async () => {
    stubStorage({});
    const agent = await startAgent({});
    await agent.sendMessage({ content: 'hi' });
    expect(sessionConfirmMode).not.toHaveBeenCalled();
    expect(sessionSendMessage).toHaveBeenCalled();
  });
});
