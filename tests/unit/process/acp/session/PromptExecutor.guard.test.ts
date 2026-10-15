/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The strict pre-prompt guard (`PromptHost.beforePrompt`, the JARVIS ladder's
 * mode confirmation) must never hold a turn forever: a live but silent agent
 * used to hang the prompt before it was sent. Running out of time is a
 * definite failure - the prompt is not sent and the session enters error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROMPT_GUARD_TIMEOUT_MS, PromptExecutor, type PromptHost } from '@process/acp/session/PromptExecutor';
import type { PromptContent } from '@process/acp/types';

const CONTENT = [{ type: 'text', text: 'do the thing' }] as unknown as PromptContent;

function createHost(beforePrompt: () => Promise<void>) {
  const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
  const client = { prompt, cancel: vi.fn().mockResolvedValue(undefined) };
  const host = {
    status: 'active',
    lifecycle: {
      client,
      sessionId: 'sess-1',
      reassertConfig: vi.fn().mockResolvedValue(undefined),
      setAuthPendingForPrompt: vi.fn(),
      teardown: vi.fn().mockResolvedValue(undefined),
    },
    messageTranslator: { onTurnStart: vi.fn(), onTurnEnd: vi.fn() },
    authNegotiator: { buildAuthRequiredData: vi.fn().mockReturnValue({}) },
    callbacks: { onSignal: vi.fn(), onContextUsage: vi.fn() },
    metrics: { recordError: vi.fn() },
    agentConfig: { agentBackend: 'claude' },
    setStatus: vi.fn((s: string) => {
      host.status = s;
    }),
    enterError: vi.fn(),
    beforePrompt,
  } as unknown as PromptHost & { status: string };
  return { host, prompt, client };
}

describe('PromptExecutor - pre-prompt guard', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('bounds the guard at 30 s and fails the turn closed without sending the prompt', async () => {
    vi.useFakeTimers();
    const { host, prompt } = createHost(() => new Promise<void>(() => {}));
    const executor = new PromptExecutor(host, 600_000);
    const turn = executor.execute(CONTENT);
    const settled = expect(turn).rejects.toThrow(/did not finish within 30 s; the prompt was not sent/);
    await vi.advanceTimersByTimeAsync(PROMPT_GUARD_TIMEOUT_MS);
    await settled;
    expect(PROMPT_GUARD_TIMEOUT_MS).toBe(30_000);
    expect(prompt).not.toHaveBeenCalled();
    expect(host.enterError).toHaveBeenCalledWith(expect.stringMatching(/did not finish within 30 s/));
  });

  it('does not time out a guard that settles in time', async () => {
    vi.useFakeTimers();
    const { host, prompt } = createHost(() => new Promise<void>((r) => setTimeout(r, PROMPT_GUARD_TIMEOUT_MS - 1)));
    const executor = new PromptExecutor(host, 600_000);
    const turn = executor.execute(CONTENT);
    await vi.advanceTimersByTimeAsync(PROMPT_GUARD_TIMEOUT_MS - 1);
    await turn;
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(host.enterError).not.toHaveBeenCalled();
  });

  it('still fails the turn on a guard rejection', async () => {
    const { host, prompt } = createHost(async () => {
      throw new Error('mode refused');
    });
    await expect(new PromptExecutor(host, 600_000).execute(CONTENT)).rejects.toThrow(/mode refused/);
    expect(prompt).not.toHaveBeenCalled();
  });
});
