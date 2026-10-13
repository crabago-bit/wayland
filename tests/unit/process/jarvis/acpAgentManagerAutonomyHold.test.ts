/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A permission request the JARVIS autonomy gate HELD for a person must reach
 * the user as a confirmation card in EVERY mode: Autopilot/bypass, a trusted
 * workspace and the guarded-auto Autopilot guardrail all auto-approve ordinary
 * requests, and none of them may approve a held one.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const { isWorkspaceTrusted } = vi.hoisted(() => ({
  isWorkspaceTrusted: vi.fn<(ws: string | undefined | null) => boolean>(() => true),
}));
vi.mock('@process/permissions/workspaceTrust', () => ({ isWorkspaceTrusted }));

// ── Manager construction mocks (mirror acpAgentManagerTeamPermission.test.ts) ──
vi.mock('@process/services/cron/CronBusyGuard', () => ({
  cronBusyGuard: { setProcessing: vi.fn(), isProcessing: vi.fn(() => false) },
}));
vi.mock('@process/utils/mainLogger', () => ({ mainLog: vi.fn(), mainWarn: vi.fn(), mainError: vi.fn() }));
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { getConfig: vi.fn(() => ({})), get: vi.fn() },
}));
vi.mock('@/common', () => ({
  ipcBridge: { acpConversation: { responseStream: { emit: vi.fn() } } },
}));
vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(() => Promise.resolve({ updateConversation: vi.fn() })),
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
  ExtensionRegistry: {
    getInstance: vi.fn(() => ({ getAll: vi.fn(() => []), getAcpAdapters: vi.fn(() => []) })),
  },
}));
vi.mock('@process/agent/acp', () => ({
  AcpAgent: class {
    sendMessage = vi.fn();
    stop = vi.fn();
    kill = vi.fn();
    cancelPrompt = vi.fn();
  },
}));
vi.mock('@process/task/BaseAgentManager', () => ({
  default: class {
    conversation_id = '';
    status: string | undefined;
    workspace = '';
    bootstrapping = false;
    yoloMode = false;
    options: Record<string, unknown> = {};
    constructor(_type: string, data: Record<string, unknown>, _emitter: unknown) {
      if (data?.conversation_id) this.conversation_id = data.conversation_id as string;
      if (data?.workspace) this.workspace = data.workspace as string;
    }
    isYoloMode() {
      return false;
    }
    addConfirmation() {}
    getConfirmations() {
      return [];
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
}));
vi.mock('@/common/utils', () => ({ parseError: vi.fn((e: unknown) => e), uuid: vi.fn(() => 'test-uuid') }));
vi.mock('@/common/chat/chatLib', () => ({ transformMessage: vi.fn(), uuid: vi.fn(() => 'uuid') }));

import AcpAgentManager from '../../../../src/process/task/AcpAgentManager';

type SignalFn = (v: unknown, backend: string) => Promise<void>;

function makeManager(mode: string) {
  const data: Record<string, unknown> = { conversation_id: 'conv-hold', backend: 'claude', workspace: '/trusted' };
  const manager = new AcpAgentManager(data as never);
  (manager as unknown as { options: Record<string, unknown> }).options = data;
  (manager as unknown as { currentMode: string }).currentMode = mode;
  return manager;
}

function heldSignal(kind: string, autonomyHold: boolean) {
  return {
    type: 'acp_permission',
    msg_id: 'msg-1',
    data: {
      toolCall: { toolCallId: 'call-1', kind, title: `${kind} tool` },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
      ],
      ...(autonomyHold ? { autonomyHold: true } : {}),
    },
  };
}

describe('AcpAgentManager - autonomy-held permission requests', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['bypassPermissions', 'yolo', 'acceptEdits', 'autoGuarded', 'default'])(
    'never auto-approves a held edit in %s mode (trusted workspace)',
    async (mode) => {
      const mgr = makeManager(mode);
      const confirm = vi.spyOn(mgr, 'confirm').mockResolvedValue(undefined);
      const addConfirmation = vi.spyOn(mgr as unknown as { addConfirmation: (c: unknown) => void }, 'addConfirmation');

      await (mgr as unknown as { handleSignalEvent: SignalFn }).handleSignalEvent(heldSignal('edit', true), 'claude');
      await vi.runAllTimersAsync();

      expect(confirm).not.toHaveBeenCalled();
      expect(addConfirmation).toHaveBeenCalledTimes(1);
      expect(addConfirmation.mock.calls[0][0]).toMatchObject({ callId: 'call-1', autonomyHold: true });
    }
  );

  it('an un-held request still auto-approves as before (bypass mode)', async () => {
    const mgr = makeManager('bypassPermissions');
    const confirm = vi.spyOn(mgr, 'confirm').mockResolvedValue(undefined);
    await (mgr as unknown as { handleSignalEvent: SignalFn }).handleSignalEvent(heldSignal('edit', false), 'claude');
    await vi.runAllTimersAsync();
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
