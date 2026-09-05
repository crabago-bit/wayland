/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// src/common/adapter/bridgeAllowlist.autonomy.bun.test.ts
// Run with: bun test src/common/adapter/bridgeAllowlist.autonomy.bun.test.ts
//
// The JARVIS autonomy ladder must not be self-promotable from a remote
// (paired-device WebSocket) client. The `jarvis.` IPC prefix is remote-denied
// and jarvisRoutes.ts is read-only, so the only door left was the GENERIC
// config setter: `agent.config.storage.set` with key `agents.autonomy` writes
// the per-agent rung map the host spawns the tool-filter shim with. Writing
// `{"claude":4}` is exactly the promotion the dedicated rails refuse.
//
// Same shape as the budgets suite next door: assert the denial, and assert a
// legitimate neighbouring write still passes so the guard cannot be widened
// into a blanket refusal without this failing.

import { describe, it, expect } from 'bun:test';
import { isAllowedForRemote, isRemoteDeniedConfigWrite } from './bridgeAllowlist';

const SET = 'subscribe-agent.config.storage.set';

/** The wire shape the WS dispatcher hands the guard: `{ id, data: { key, data } }`. */
function invocation(key: string, data: unknown): unknown {
  return { id: 'req-1', data: { key, data } };
}

describe('bridgeAllowlist - agents.autonomy is not remotely writable', () => {
  it('denies a remote write of the per-agent rung map', () => {
    expect(isRemoteDeniedConfigWrite(SET, invocation('agents.autonomy', { claude: 4 }))).toBe(true);
  });

  it('denies it whatever the payload says - the KEY is the gate', () => {
    for (const payload of [undefined, null, {}, { claude: 1 }, 'nonsense']) {
      expect(isRemoteDeniedConfigWrite(SET, invocation('agents.autonomy', payload))).toBe(true);
    }
  });

  it('still denies the neighbouring protected keys (no regression)', () => {
    expect(isRemoteDeniedConfigWrite(SET, invocation('mcp.config', []))).toBe(true);
    expect(isRemoteDeniedConfigWrite(SET, invocation('workspace.trustLevel', 'trusted'))).toBe(true);
  });

  it('still allows an unrelated config write', () => {
    // `agents.hidden` is the sibling per-agent setting and is deliberately NOT
    // protected: hiding an agent from a toolbar grants no capability.
    expect(isRemoteDeniedConfigWrite(SET, invocation('agents.hidden', ['gemini']))).toBe(false);
  });

  it('keeps the jarvis.* read rail denied to remote callers', () => {
    expect(isAllowedForRemote('subscribe-jarvis.approvals')).toBe(false);
    expect(isAllowedForRemote('subscribe-jarvis.hardFloor')).toBe(false);
  });
});
