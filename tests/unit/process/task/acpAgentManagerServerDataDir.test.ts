/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The standalone bun WebUI server resolves `electron` to the npm package,
 * whose `app` is undefined. Every engine home AcpAgentManager scopes under the
 * data root (Flux claude/codex/hermes, native codex) used `app.getPath`, threw,
 * and the failure was swallowed - the agent silently ran on the user's native
 * config. They now share the Fuigo home's data-dir fallback (DATA_DIR there).
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockGet, capturedAgentConfigs, isWorkspaceTrusted } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  capturedAgentConfigs: [] as Array<Record<string, unknown>>,
  isWorkspaceTrusted: vi.fn(() => false),
}));

const electronState = vi.hoisted(() => ({
  app: { getPath: (_name: string) => '/tmp/userData' } as { getPath: (name: string) => string } | undefined,
}));
vi.mock('electron', () => ({
  get app() {
    return electronState.app;
  },
}));
const { ensureFuigoHomeMock } = vi.hoisted(() => ({ ensureFuigoHomeMock: vi.fn() }));
vi.mock('@process/agent/fuigo/launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/process/agent/fuigo/launch')>();
  return { ...actual, ensureFuigoHome: ensureFuigoHomeMock };
});
vi.mock('@process/permissions/workspaceTrust', () => ({ isWorkspaceTrusted }));
vi.mock('@process/agent/fuigo/runtime', () => ({
  resolveFuigoBinary: vi.fn(() => ({ path: '/tmp/userData/bundled-fuigo/fuigo', version: '1.0.13' })),
}));
vi.mock('@process/connectors/fluxKey', () => ({ readConnectedFluxKey: vi.fn(async () => 'sk-flux-test') }));
vi.mock('@process/services/cron/CronBusyGuard', () => ({
  cronBusyGuard: { setProcessing: vi.fn(), isProcessing: vi.fn(() => false) },
}));
vi.mock('@process/utils/mainLogger', () => ({ mainLog: vi.fn(), mainWarn: vi.fn(), mainError: vi.fn() }));
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { getConfig: vi.fn(() => ({})), get: mockGet },
}));
vi.mock('@/common', () => ({ ipcBridge: { acpConversation: { responseStream: { emit: vi.fn() } } } }));
vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(() =>
    Promise.resolve({ updateConversation: vi.fn(), getConversation: vi.fn(), getDriver: vi.fn(() => ({})) })
  ),
}));
vi.mock('@process/providers/storage/ProviderRepository', () => ({
  ProviderRepository: class {
    list() {
      return [];
    }
    listAll() {
      return [];
    }
    getAll() {
      return [];
    }
  },
}));
vi.mock('@process/utils/message', () => ({
  addMessage: vi.fn(),
  addOrUpdateMessage: vi.fn(),
  nextTickToLocalFinish: vi.fn((cb: () => void) => cb()),
}));
vi.mock('@process/channels/agent/ChannelEventBus', () => ({
  channelEventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), emitAgentMessage: vi.fn() },
}));
vi.mock('@process/utils/previewUtils', () => ({ handlePreviewOpenEvent: vi.fn() }));
vi.mock('@process/extensions', () => ({
  ExtensionRegistry: { getInstance: vi.fn(() => ({ getAll: vi.fn(() => []), getAcpAdapters: vi.fn(() => []) })) },
}));
vi.mock('@process/acp/compat/AcpAgentV2', () => ({
  AcpAgentV2: class {
    constructor(config: Record<string, unknown>) {
      capturedAgentConfigs.push(config);
    }
    start = vi.fn(async () => {});
    getModelInfo = vi.fn(() => null);
    stop = vi.fn();
    kill = vi.fn();
    cancelPrompt = vi.fn();
  },
}));
vi.mock('@process/agent/acp', () => ({
  AcpAgent: class {
    sendMessage = vi.fn().mockResolvedValue({ success: true });
    stop = vi.fn();
    kill = vi.fn();
    cancelPrompt = vi.fn();
  },
}));
vi.mock('@process/task/BaseAgentManager', () => ({
  default: class {
    conversation_id = '';
    workspace = '';
    yoloMode = false;
    currentMode = 'default';
    constructor(_type: string, data: Record<string, unknown>) {
      if (data?.conversation_id) this.conversation_id = data.conversation_id as string;
      if (data?.workspace) this.workspace = data.workspace as string;
    }
    isYoloMode() {
      return false;
    }
  },
}));
vi.mock('@process/task/ConversationTurnCompletionService', () => ({
  ConversationTurnCompletionService: { getInstance: () => ({ notifyPotentialCompletion: vi.fn() }) },
}));
vi.mock('@process/task/IpcAgentEventEmitter', () => ({ IpcAgentEventEmitter: vi.fn() }));
vi.mock('@process/task/CronCommandDetector', () => ({ hasCronCommands: vi.fn(() => false) }));
vi.mock('@process/task/MessageMiddleware', () => ({
  extractTextFromMessage: vi.fn(() => ''),
  processCronInMessage: vi.fn((x: unknown) => x),
}));
vi.mock('@process/task/ThinkTagDetector', () => ({ stripThinkTags: vi.fn((x: unknown) => x) }));
vi.mock('@process/utils/initAgent', () => ({
  hasNativeSkillSupport: vi.fn(() => false),
  repairStagedTideSkill: vi.fn(async () => {}),
}));
vi.mock('@process/task/agentUtils', () => ({
  buildFirstMessageRulesWithSkillsIndex: vi.fn(() => Promise.resolve({ rules: '', loadedSkills: [] })),
  resolveCapabilitiesManifest: vi.fn(() => Promise.resolve(undefined)),
  consumePendingSessionSkills: vi.fn(() => Promise.resolve('')),
  CAPABILITIES_MANIFEST_HEADER: '[Wayland Capabilities]',
  isConciergeAssistant: vi.fn(() => false),
}));
vi.mock('@process/services/constitution/composePrompt', () => ({
  composePrompt: ({ basePrompt = '' }: { basePrompt?: string }) => ({ text: basePrompt }),
}));
vi.mock('@/common/utils', () => ({ parseError: vi.fn((e: unknown) => e), uuid: vi.fn(() => 'test-uuid') }));
vi.mock('@/common/chat/chatLib', () => ({ transformMessage: vi.fn(), uuid: vi.fn(() => 'uuid') }));

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; userData: unknown }> }));
vi.mock('@process/task/claudeConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/process/task/claudeConfig')>()),
  materializeFluxClaudeConfigDir: vi.fn(async (userData: string) => {
    calls.push({ fn: 'claude', userData });
    return `${userData}/flux-claude`;
  }),
}));
vi.mock('@process/task/codexConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/process/task/codexConfig')>()),
  materializeFluxCodexHome: vi.fn(async (userData: string) => {
    calls.push({ fn: 'codex-flux', userData });
    return `${userData}/flux-codex`;
  }),
  materializeNativeCodexHome: vi.fn(async (userData: string) => {
    calls.push({ fn: 'codex-native', userData });
    return `${userData}/native-codex`;
  }),
}));
vi.mock('@process/task/hermesConfig', () => ({
  materializeFluxHermesHome: vi.fn(async (userData: string) => {
    calls.push({ fn: 'hermes', userData });
    return `${userData}/flux-hermes`;
  }),
}));

import AcpAgentManager from '../../../../src/process/task/AcpAgentManager';

type Resolved = { customEnv?: Record<string, string> };

const FLUX = { routing: 'flux', stripKeys: [], env: { FLUX_API_KEY: 'k' }, fluxModelId: 'flux-auto' };
const NATIVE = { routing: 'native', stripKeys: [], env: {}, fluxModelId: undefined };

async function resolve(backend: string, routing: typeof FLUX | typeof NATIVE): Promise<Resolved> {
  const m = new AcpAgentManager({ conversation_id: 'c1', backend: backend as never, workspace: '/tmp/ws' });
  const inner = m as unknown as {
    computeFluxRouting: () => Promise<unknown>;
    loadCodexSessionMcpServers: () => Promise<unknown>;
    announceDroppedUserHooks: () => Promise<void>;
    resolveAgentCliConfig: (d: unknown) => Promise<Resolved>;
  };
  vi.spyOn(inner, 'computeFluxRouting').mockResolvedValue(routing);
  vi.spyOn(inner, 'loadCodexSessionMcpServers').mockResolvedValue({ selectedServers: [], managedServerNames: [] });
  vi.spyOn(inner, 'announceDroppedUserHooks').mockResolvedValue(undefined);
  return inner.resolveAgentCliConfig({ conversation_id: 'c1', backend, workspace: '/tmp/ws' });
}

describe('AcpAgentManager engine homes in the standalone WebUI server', () => {
  const saved = { app: electronState.app, dataDir: process.env.DATA_DIR };
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue(undefined);
    calls.length = 0;
    electronState.app = undefined;
    process.env.DATA_DIR = '/srv/stage-data';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    electronState.app = saved.app;
    if (saved.dataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = saved.dataDir;
  });

  it('scopes a Flux-routed claude CLAUDE_CONFIG_DIR under DATA_DIR', async () => {
    const res = await resolve('claude', FLUX);
    expect(calls).toEqual([{ fn: 'claude', userData: '/srv/stage-data' }]);
    expect(res.customEnv?.CLAUDE_CONFIG_DIR).toBe('/srv/stage-data/flux-claude');
  });

  it('scopes a Flux-routed codex CODEX_HOME under DATA_DIR', async () => {
    const res = await resolve('codex', FLUX);
    expect(calls).toEqual([{ fn: 'codex-flux', userData: '/srv/stage-data' }]);
    expect(res.customEnv?.CODEX_HOME).toBe('/srv/stage-data/flux-codex');
  });

  it('scopes a Flux-routed hermes HERMES_HOME under DATA_DIR', async () => {
    const res = await resolve('hermes', FLUX);
    expect(calls).toEqual([{ fn: 'hermes', userData: '/srv/stage-data' }]);
    expect(res.customEnv?.HERMES_HOME).toBe('/srv/stage-data/flux-hermes');
  });

  it('scopes a native codex CODEX_HOME under DATA_DIR', async () => {
    const res = await resolve('codex', NATIVE);
    expect(calls).toEqual([{ fn: 'codex-native', userData: '/srv/stage-data' }]);
    expect(res.customEnv?.CODEX_HOME).toBe('/srv/stage-data/native-codex');
  });

  it('still uses Electron userData when the app exists', async () => {
    electronState.app = { getPath: () => '/tmp/userData' };
    await resolve('claude', FLUX);
    expect(calls).toEqual([{ fn: 'claude', userData: '/tmp/userData' }]);
  });
});
