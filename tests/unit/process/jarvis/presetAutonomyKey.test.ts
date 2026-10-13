/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every Warrior pack agent is a PRESET assistant. buildAgentConversationParams
 * stores a preset's id only as `presetAssistantId` (Guid page and Teams alike),
 * so the autonomy key must fall back to it - otherwise the ladder reads the bare
 * `claude` key, finds nothing, and never applies to a UI or team chat.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const { mockGet, capturedAgentConfigs } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  capturedAgentConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@process/services/cron/CronBusyGuard', () => ({
  cronBusyGuard: { setProcessing: vi.fn(), isProcessing: vi.fn(() => false) },
}));
vi.mock('@process/utils/mainLogger', () => ({ mainLog: vi.fn(), mainWarn: vi.fn(), mainError: vi.fn() }));
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { getConfig: vi.fn(() => ({})), get: mockGet },
}));
vi.mock('@/common', () => ({ ipcBridge: { acpConversation: { responseStream: { emit: vi.fn() } } } }));
vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(() => Promise.resolve({ updateConversation: vi.fn(), getConversation: vi.fn() })),
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
    start = vi.fn().mockResolvedValue(undefined);
    getModelInfo = vi.fn(() => null);
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
vi.mock('@process/utils/initAgent', () => ({ hasNativeSkillSupport: vi.fn(() => false) }));
vi.mock('@process/task/agentUtils', () => ({
  prepareFirstMessageWithSkillsIndex: vi.fn((x: string) => Promise.resolve({ content: x, loadedSkills: [] })),
  isConciergeAssistant: vi.fn(() => false),
}));
vi.mock('@/common/utils', () => ({ parseError: vi.fn((e: unknown) => e), uuid: vi.fn(() => 'test-uuid') }));
vi.mock('@/common/chat/chatLib', () => ({ transformMessage: vi.fn(), uuid: vi.fn(() => 'uuid') }));
vi.mock('@process/services/jarvis/approvalsPath', () => ({
  resolveApprovalsLogPath: () => '/data/jarvis/approvals.jsonl',
}));
vi.mock('@process/services/jarvis/hardFloor', () => ({ readHardFloorKeywords: () => [] }));

import AcpAgentManager from '../../../../src/process/task/AcpAgentManager';
import { buildAgentConversationParams } from '../../../../src/common/utils/buildAgentConversationParams';
import { resolveConfiguredSpawnAutonomy } from '../../../../src/process/services/jarvis/sessionAutonomy';
import type { TProviderWithModel } from '../../../../src/common/config/storage';

const PACK = 'pack-warrior-estimator';
const model = { id: 'p', name: 'p', useModel: 'm' } as unknown as TProviderWithModel;

/** What the agent factory hands AcpAgentManager: `{ ...conversation.extra, conversation_id }`. */
async function ladderFor(extra: Record<string, unknown>) {
  const data = { ...extra, conversation_id: 'conv-preset' };
  const m = new AcpAgentManager(data as never);
  await m.initAgent(data as never);
  const config = capturedAgentConfigs.at(-1) as { backend: string; extra: { autonomyAgentId?: string } };
  return resolveConfiguredSpawnAutonomy({ backend: config.backend, customAgentId: config.extra.autonomyAgentId });
}

describe('autonomy key for preset (pack) assistants', () => {
  beforeEach(() => {
    capturedAgentConfigs.length = 0;
    mockGet.mockReset();
    mockGet.mockImplementation(async (key: string) => {
      if (key === 'agents.autonomy') return { [`custom:${PACK}`]: 2 };
      if (key === 'assistants') return [{ id: PACK, name: 'Estimator', isPreset: true, presetAgentType: 'claude' }];
      return undefined;
    });
  });

  it('Guid page: a preset conversation is laddered under custom:<presetAssistantId>', async () => {
    const params = buildAgentConversationParams({
      backend: 'claude',
      name: 'Estimator',
      workspace: '/tmp/ws',
      model,
      presetAssistantId: PACK,
      isPreset: true,
      presetAgentType: 'claude',
    });
    expect((params.extra as Record<string, unknown>).customAgentId).toBeUndefined();
    expect(await ladderFor(params.extra as Record<string, unknown>)).toMatchObject({
      agent: `custom:${PACK}`,
      rung: 2,
    });
  });

  it('Teams: a preset teammate (TeamSessionService argument shape) is laddered too', async () => {
    // TeamSessionService.buildConversationParams passes customAgentId + isPreset
    // + presetAgentType: backend, which lands as presetAssistantId only.
    const params = buildAgentConversationParams({
      backend: 'claude',
      name: 'Team - Estimator',
      agentName: 'Estimator',
      workspace: '/tmp/ws',
      model,
      customAgentId: PACK,
      isPreset: true,
      presetAgentType: 'claude',
      extra: { teamId: 't1' },
    });
    expect((params.extra as Record<string, unknown>).customAgentId).toBeUndefined();
    expect(await ladderFor(params.extra as Record<string, unknown>)).toMatchObject({
      agent: `custom:${PACK}`,
      rung: 2,
    });
  });

  it('a plain claude chat stays off the ladder', async () => {
    const params = buildAgentConversationParams({ backend: 'claude', name: 'c', workspace: '/tmp/ws', model });
    expect(await ladderFor(params.extra as Record<string, unknown>)).toBeUndefined();
  });
});
