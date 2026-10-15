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
import { AcpAgentV2, LADDERED_MODE_CONFIRM_TIMEOUT_MS } from '@process/acp/compat/AcpAgentV2';
import type { OldAcpAgentConfig } from '@process/acp/compat/typeBridge';
import type { AgentConfig, SessionCallbacks } from '@process/acp/types';
import type { SessionOptions } from '@process/acp/session/AcpSession';
import { loadRuntimeMcpServers } from '@process/services/mcpServices/runtimeMcpServers';
import { TOOL_FILTER_SCRIPT } from '@process/services/mcpServices/builtinMcpRuntime';
import { resetAutonomyRungCache } from '@process/services/jarvis/sessionAutonomy';
import { ProcessConfig } from '@process/utils/initStorage';
import { McpConfig } from '@process/acp/session/McpConfig';
import type { IMcpServer } from '@/common/config/storage';

let capturedConfig: AgentConfig;
let capturedCallbacks: SessionCallbacks;
let capturedOptions: SessionOptions | undefined;
const sessionSetMode = vi.fn();
const VERIFIED_INIT = { agentInfo: { name: '@agentclientprotocol/claude-agent-acp', version: '0.74.0' } };
let initializeResult: unknown = VERIFIED_INIT;
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
    start = vi.fn(() =>
      setTimeout(() => {
        capturedCallbacks.onInitialize?.(initializeResult);
        capturedCallbacks.onStatusChange('active');
      }, 0)
    );
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
const pluginSkill = {
  requested: 'contractor-os:line-item-pricing',
  sessionName: 'wayland-skills:contractor-os:line-item-pricing',
  source: 'plugin-copy',
  sourceDir: '/data/skill-sources/contractor-os/skills/line-item-pricing',
};
const buildSkillPlugin = vi.fn(async (opts: { sessionKey: string }) => ({
  path: `/data/skill-plugins/${opts.sessionKey}`,
  skills: [pluginSkill],
}));
const removeSkillPlugin = vi.fn(async (_dir: string) => {});
vi.mock('@process/services/jarvis/ladderedSkillPlugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@process/services/jarvis/ladderedSkillPlugin')>()),
  buildLadderedSkillPlugin: (opts: { sessionKey: string }) => buildSkillPlugin(opts),
  removeLadderedSkillPlugin: (dir: string) => removeSkillPlugin(dir),
}));

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

/**
 * The user connectors exactly as SessionLifecycle publishes them: AcpAgentV2
 * stores the storage source (with the ladder in its request) and the session
 * projects it against the live initialize capabilities.
 */
function projectedServers() {
  const source = capturedConfig.mcpStorageSource;
  if (!source) return [];
  return McpConfig.projectStorageConfig(source.servers, {
    ...source.request,
    capabilities: { stdio: true, http: true, sse: true },
  }).servers;
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
    initializeResult = VERIFIED_INIT;
    buildSkillPlugin.mockClear();
    removeSkillPlugin.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a pack agent at rung 2: shimmed connectors, a permission gate, bypass clamped', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    const agent = await startAgent({ customAgentId: PACK, sessionMode: 'bypassPermissions', yoloMode: true });

    const server = projectedServers().find((s) => s.name === 'warrior-ghl') as { args: string[] };
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
    // Claude Code's own allow rules / defaultMode / hooks are not loaded; the
    // assistant's skills come as a Wayland-owned plugin instead.
    expect(capturedConfig.sessionMeta).toEqual({
      claudeCode: {
        options: {
          settingSources: [],
          plugins: [{ type: 'local', path: '/data/skill-plugins/conv-1', skipMcpDiscovery: true }],
        },
      },
      // The names the session lists the skills under, on every new/load/fork.
      systemPrompt: {
        append: expect.stringContaining(
          '`contractor-os:line-item-pricing` → `wayland-skills:contractor-os:line-item-pricing`'
        ),
      },
    });

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

  it('builds the skill plugin from the assistant’s own skills, keyed by the conversation', async () => {
    stubStorage({ [`custom:${PACK}`]: 3 });
    await startAgent({
      customAgentId: PACK,
      enabledSkills: ['crew-core-brand-context', 'contractor-os:line-item-pricing'],
      excludeBuiltinSkills: ['cron'],
    });
    expect(buildSkillPlugin).toHaveBeenCalledWith({
      backend: 'claude',
      sessionKey: 'conv-1',
      enabledSkills: ['crew-core-brand-context', 'contractor-os:line-item-pricing'],
      excludeBuiltinSkills: ['cron'],
    });
  });

  it('kill() removes the plugin dir and the next start() rebuilds it before the session restarts', async () => {
    stubStorage({ [`custom:${PACK}`]: 3 });
    const agent = await startAgent({ customAgentId: PACK });
    expect(buildSkillPlugin).toHaveBeenCalledTimes(1);
    await agent.kill();
    expect(removeSkillPlugin).toHaveBeenCalledWith('/data/skill-plugins/conv-1');
    await agent.kill(); // a second kill has nothing left to remove
    expect(removeSkillPlugin).toHaveBeenCalledTimes(1);
    buildSkillPlugin.mockResolvedValueOnce({ path: '/data/skill-plugins/conv-1.alt', skills: [] });
    await agent.start();
    expect(buildSkillPlugin).toHaveBeenCalledTimes(2);
    expect(capturedConfig.sessionMeta).toEqual({
      claudeCode: {
        options: {
          settingSources: [],
          plugins: [{ type: 'local', path: '/data/skill-plugins/conv-1.alt', skipMcpDiscovery: true }],
        },
      },
    });
  });

  it('a skill plugin that fails to build costs only the skills: still laddered, no plugins', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    buildSkillPlugin.mockRejectedValueOnce(new Error('disk full'));
    await startAgent({ customAgentId: PACK });
    expect(capturedOptions?.permissionGate).toBeDefined();
    expect(capturedConfig.sessionMeta).toEqual({ claudeCode: { options: { settingSources: [] } } });
    expect(error).toHaveBeenCalled();
  });

  it('a laddered Fuigo agent gets its plugin as the ONLY pluginDirs entry, readable, and no Claude meta', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    const agent = new AcpAgentV2({
      id: 'conv-f',
      backend: 'fuigo',
      workingDir: '/workspace',
      onStreamEvent: vi.fn(),
      onSignalEvent: vi.fn(),
      extra: { backend: 'fuigo', customAgentId: PACK, sessionMode: 'bypassPermissions' },
    });
    await agent.start();
    // Replaces the `<workspace>/.wayland` staging (merged over sessionMetadata).
    expect(capturedConfig.sessionMeta).toEqual({ pluginDirs: ['/data/skill-plugins/conv-f'] });
    expect(capturedConfig.readOnlyRoots).toEqual(['/data/skill-plugins/conv-f']);
    // Same shim, gate and clamp as every laddered backend.
    const server = projectedServers().find((s) => s.name === 'warrior-ghl') as { args: string[] };
    expect(server.args[0]).toContain(TOOL_FILTER_SCRIPT);
    expect(capturedOptions?.permissionGate).toBeDefined();
    expect(capturedOptions?.beforePrompt).toBeDefined();
    expect(capturedConfig.initialDesired?.mode).toBe('default');
  });

  it('a laddered Fuigo agent refuses engine commands that change approvals or plugins', async () => {
    stubStorage({ [`custom:${PACK}`]: 3 });
    const agent = new AcpAgentV2({
      id: 'conv-g',
      backend: 'fuigo',
      workingDir: '/workspace',
      onStreamEvent: vi.fn(),
      onSignalEvent: vi.fn(),
      extra: { backend: 'fuigo', customAgentId: PACK },
    });
    await agent.start();
    for (const content of ['/always-approve on', '  /plugins add /tmp/x', '/reload-plugins', '/PLUGINS trust /x']) {
      const result = await agent.sendMessage({ content });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.message).toMatch(/not available to a laddered agent/);
    }
    expect(sessionSendMessage).not.toHaveBeenCalled();
    // Ordinary text - including a mention of the command - still goes through.
    expect((await agent.sendMessage({ content: 'what does /always-approve do?' })).success).toBe(true);
    expect((await agent.sendMessage({ content: '/always-approvez' })).success).toBe(true);
    expect(sessionSendMessage).toHaveBeenCalledTimes(2);
  });

  it('a NON-laddered Fuigo chat keeps the workspace staging and its slash commands', async () => {
    stubStorage({});
    const agent = new AcpAgentV2({
      id: 'conv-h',
      backend: 'fuigo',
      workingDir: '/workspace',
      onStreamEvent: vi.fn(),
      onSignalEvent: vi.fn(),
      extra: { backend: 'fuigo' },
    });
    await agent.start();
    expect(capturedConfig.sessionMeta).toBeUndefined();
    expect(capturedConfig.readOnlyRoots).toBeUndefined();
    expect(buildSkillPlugin).not.toHaveBeenCalled();
    expect((await agent.sendMessage({ content: '/always-approve on' })).success).toBe(true);
  });

  it('an agent with NO configured rung keeps today’s behaviour', async () => {
    stubStorage({ [`custom:${PACK}`]: 1 });
    const agent = await startAgent({ sessionMode: 'bypassPermissions', yoloMode: true });

    const server = projectedServers().find((s) => s.name === 'warrior-ghl') as { args: string[] };
    expect(server.args.join(' ')).not.toContain(TOOL_FILTER_SCRIPT);
    expect(capturedOptions?.permissionGate).toBeUndefined();
    expect(capturedConfig.initialDesired?.mode).toBe('bypassPermissions');
    expect(capturedConfig.yoloMode).toBe(true);
    expect(capturedConfig.sessionMeta).toBeUndefined();
    expect(buildSkillPlugin).not.toHaveBeenCalled();
    await agent.kill();
    expect(removeSkillPlugin).not.toHaveBeenCalled();
    void agent.setMode('bypassPermissions');
    expect(sessionSetMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('an unreadable rung store with no prior copy runs unladdered (plain chats unaffected)', async () => {
    resetAutonomyRungCache();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubStorage('throw');
    await startAgent({ customAgentId: PACK });
    const server = projectedServers().find((s) => s.name === 'warrior-ghl') as { args: string[] };
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
    const server = projectedServers().find((s) => s.name === 'warrior-ghl') as { args: string[] };
    expect(server.args[server.args.indexOf('--rung') + 1]).toBe('1');
    // A plain chat stays off the ladder on the cached copy too.
    await startAgent({});
    expect(capturedOptions?.permissionGate).toBeUndefined();
  });

  it('enforces the ladder the manager resolved for the spawn and never re-reads the store', async () => {
    resetAutonomyRungCache();
    // The store now says rung 1, but the spawn (and its Fuigo home) was chosen
    // on the manager's rung-2 snapshot: the session must agree with the spawn.
    stubStorage({ [`custom:${PACK}`]: 1 });
    const get = vi.mocked(ProcessConfig.get);
    const autonomy = {
      agent: `custom:${PACK}`,
      rung: 2 as const,
      hardFloorKeywords: ['wire'],
      logPath: '/data/jarvis/approvals.jsonl',
    };
    await startAgent({ customAgentId: PACK, spawnAutonomy: { autonomy } });
    expect(get.mock.calls.some(([key]) => key === 'agents.autonomy')).toBe(false);
    const server = projectedServers().find((s) => s.name === 'warrior-ghl') as { args: string[] };
    expect(server.args[server.args.indexOf('--rung') + 1]).toBe('2');
    expect(capturedOptions?.permissionGate).toBeDefined();
  });

  it('a manager-resolved UNLADDERED spawn stays unladdered even if the store now lists the agent', async () => {
    stubStorage({ [`custom:${PACK}`]: 1 });
    await startAgent({ customAgentId: PACK, spawnAutonomy: { autonomy: undefined } });
    expect(capturedOptions?.permissionGate).toBeUndefined();
    expect(capturedOptions?.beforePrompt).toBeUndefined();
  });

  it('every laddered prompt is guarded: the session gets a beforePrompt that confirms the clamped mode', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    await startAgent({ customAgentId: PACK, sessionMode: 'bypassPermissions' });
    expect(capturedOptions?.beforePrompt).toBeDefined();
    await capturedOptions!.beforePrompt!();
    expect(sessionConfirmMode).toHaveBeenCalledWith('default');
  });

  it('the guard rejects (so the session aborts the prompt) when the agent refuses the laddered mode', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    sessionConfirmMode.mockRejectedValue(new Error('Invalid params'));
    await startAgent({ customAgentId: PACK });
    await expect(capturedOptions!.beforePrompt!()).rejects.toThrow(/did not accept session mode "default"/);
  });

  it('the guard rejects when the session cannot take a mode change before the prompt', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    sessionConfirmMode.mockResolvedValue(null);
    await startAgent({ customAgentId: PACK });
    await expect(capturedOptions!.beforePrompt!()).rejects.toThrow(/could not take a mode change/);
  });

  it('the guard fails closed when the agent never answers the mode change (30 s bound)', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    sessionConfirmMode.mockReturnValue(new Promise(() => {}));
    await startAgent({ customAgentId: PACK });
    vi.useFakeTimers();
    try {
      const guard = expect(capturedOptions!.beforePrompt!()).rejects.toThrow(
        /did not accept session mode "default" \(no answer within 30 s\)/
      );
      await vi.advanceTimersByTimeAsync(LADDERED_MODE_CONFIRM_TIMEOUT_MS);
      await guard;
      // Writes stay refused.
      const write = {
        sessionId: 's',
        toolCall: { toolCallId: 'c', title: 'Write a.md', kind: 'edit' as const },
        options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' as const }],
      };
      expect(capturedOptions!.permissionGate!.check(write).action).toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a mid-turn re-apply the agent never answers stops the session (30 s bound)', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    sessionConfirmMode.mockReturnValue(new Promise(() => {}));
    await startAgent({ customAgentId: PACK });
    vi.useFakeTimers();
    try {
      capturedCallbacks.onModeUpdate({ currentModeId: 'auto', availableModes: [] } as never);
      await vi.advanceTimersByTimeAsync(LADDERED_MODE_CONFIRM_TIMEOUT_MS - 1);
      expect(sessionStop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(sessionStop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a mode report while the session is not ready does NOT stop it', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    sessionConfirmMode.mockResolvedValue(null);
    await startAgent({ customAgentId: PACK });
    capturedCallbacks.onModeUpdate({ currentModeId: 'auto', availableModes: [] } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(sessionStop).not.toHaveBeenCalled();
  });

  it('a non-laddered session has no prompt guard', async () => {
    stubStorage({});
    await startAgent({});
    expect(capturedOptions?.beforePrompt).toBeUndefined();
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

  it('an expired autonomy hold in an attended chat says so and takes the card down', async () => {
    stubStorage({ [`custom:${PACK}`]: 2 });
    const onSignalEvent = vi.fn();
    const onStreamEvent = vi.fn();
    const agent = new AcpAgentV2({
      id: 'conv-3',
      backend: 'claude',
      workingDir: '/workspace',
      onStreamEvent,
      onSignalEvent,
      extra: { backend: 'claude', customAgentId: PACK },
    });
    await agent.start();
    capturedOptions!.onPermissionHoldExpired!({
      callId: 'c9',
      title: 'Write a.md',
      deadlineMs: 900_000,
      scheduled: false,
    });
    expect(onSignalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'acp_permission_expired', data: { callId: 'c9' } })
    );
    const tip = onStreamEvent.mock.calls.map((c) => c[0]).find((m) => m.type === 'tips');
    expect(tip.data.content).toMatch(/autonomy ladder \(rung 2\)/);
    expect(tip.data.content).not.toMatch(/scheduled run/);
  });

  it.each([
    ['an old bridge', { agentInfo: { name: '@agentclientprotocol/claude-agent-acp', version: '0.44.0' } }],
    ['a new major', { agentInfo: { name: '@agentclientprotocol/claude-agent-acp', version: '1.0.0' } }],
    ['another agent', { agentInfo: { name: 'some-fork', version: '0.80.0' } }],
    ['no agentInfo', {}],
  ])('fails CLOSED for a laddered agent on %s (override not confirmable)', async (_label, init) => {
    stubStorage({ [`custom:${PACK}`]: 3 });
    initializeResult = init;
    await startAgent({ customAgentId: PACK });
    await expect(capturedOptions!.beforePrompt!()).rejects.toThrow(/cannot be confirmed/);
    expect(sessionConfirmMode).not.toHaveBeenCalled();
  });

  it('an unverified bridge does not affect a NON-laddered chat', async () => {
    stubStorage({});
    initializeResult = {};
    const agent = await startAgent({});
    expect((await agent.sendMessage({ content: 'hi' })).success).toBe(true);
  });
});
