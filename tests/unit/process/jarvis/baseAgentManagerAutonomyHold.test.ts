/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BaseAgentManager's blanket yolo auto-confirms by INDEX. A confirmation the
 * JARVIS autonomy gate held for a person must be exempt, like a filesystem
 * boundary card.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IAgentEventEmitter } from '../../../../src/process/task/IAgentEventEmitter';

vi.mock('@/common/platform', () => ({
  getPlatformServices: () => ({
    paths: { isPackaged: () => false, getAppPath: () => null },
    worker: {
      fork: vi.fn(() => ({ on: vi.fn().mockReturnThis(), postMessage: vi.fn(), kill: vi.fn() })),
    },
  }),
}));
vi.mock('../../../../src/process/utils/shellEnv', () => ({ getEnhancedEnv: vi.fn(() => ({})) }));

import BaseAgentManager from '../../../../src/process/task/BaseAgentManager';

function makeAgent() {
  const emitter: IAgentEventEmitter = {
    emitConfirmationAdd: vi.fn(),
    emitConfirmationUpdate: vi.fn(),
    emitConfirmationRemove: vi.fn(),
    emitMessage: vi.fn(),
  };
  class TestAgent extends BaseAgentManager<unknown> {
    constructor() {
      super('acp', { yoloMode: true }, emitter);
    }
    add(conf: Parameters<BaseAgentManager<unknown>['addConfirmation']>[0]) {
      this.addConfirmation(conf);
    }
  }
  const agent = new TestAgent();
  (agent as unknown as { conversation_id: string }).conversation_id = 'conv';
  return { agent, emitter };
}

const card = (autonomyHold?: boolean) => ({
  id: 'm1',
  callId: 'c1',
  description: 'd',
  options: [{ label: 'Allow', value: 'allow' }],
  ...(autonomyHold ? { autonomyHold } : {}),
});

describe('BaseAgentManager.addConfirmation - autonomy hold', () => {
  it('yolo does not auto-confirm a held card; it is surfaced', () => {
    vi.useFakeTimers();
    try {
      const { agent, emitter } = makeAgent();
      const confirm = vi.spyOn(agent, 'confirm').mockResolvedValue(undefined as never);
      agent.add(card(true));
      vi.runAllTimers();
      expect(confirm).not.toHaveBeenCalled();
      expect(emitter.emitConfirmationAdd).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('yolo still auto-confirms an ordinary card', () => {
    vi.useFakeTimers();
    try {
      const { agent } = makeAgent();
      const confirm = vi.spyOn(agent, 'confirm').mockResolvedValue(undefined as never);
      agent.add(card());
      vi.runAllTimers();
      expect(confirm).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
