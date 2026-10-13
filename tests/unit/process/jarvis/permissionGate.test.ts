/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The autonomy gate at the ACP permission layer: the real PermissionResolver
 * with the real gate, recording ledger rows through an injected sink.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { PermissionResolver } from '@process/acp/session/PermissionResolver';
import { AUTONOMY_HOLD_DEADLINE_MS, createAutonomyPermissionGate } from '@process/services/jarvis/sessionAutonomy';
import type { ApprovalRecord } from '@process/services/jarvis/approvalsLog';
import type { AutonomyRung } from '@/common/jarvis/autonomy';
import type { PermissionUIData } from '@process/acp/types';

const LOG = '/data/jarvis/approvals.jsonl';

function setup(rung: AutonomyRung, opts: { yolo?: boolean; holdDeadlineMs?: number } = {}) {
  const rows: ApprovalRecord[] = [];
  const append = vi.fn((path: string, row: ApprovalRecord) => {
    expect(path).toBe(LOG);
    rows.push(row);
  });
  const gate = createAutonomyPermissionGate(
    { agent: 'custom:pack-warrior-estimator', rung, hardFloorKeywords: ['wire'], logPath: LOG },
    'claude',
    { append, now: () => 1234 }
  );
  const persist = vi.fn();
  const resolver = new PermissionResolver({
    autoApproveAll: opts.yolo ?? false,
    gate,
    persist,
    holdDeadlineMs: opts.holdDeadlineMs,
  });
  return { resolver, rows, persist };
}

function request(
  title: string,
  kind: string,
  callId = 'call-1',
  rawInput?: Record<string, unknown>,
  options?: RequestPermissionRequest['options']
): RequestPermissionRequest {
  return {
    sessionId: 's',
    toolCall: { toolCallId: callId, title, kind: kind as RequestPermissionRequest['toolCall']['kind'], rawInput },
    options: options ?? [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  };
}

describe('autonomy permission gate', () => {
  it('denies a hard-floor call and logs it - even under blanket YOLO at rung 4', async () => {
    const { resolver, rows } = setup(4, { yolo: true });
    const ui = vi.fn();
    const result = await resolver.evaluate(request('rm -rf ./bids', 'execute', 'c1', { command: 'rm -rf ./bids' }), ui);
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(ui).not.toHaveBeenCalled();
    expect(rows).toEqual([
      expect.objectContaining({
        ts: 1234,
        agent: 'custom:pack-warrior-estimator',
        rung: 4,
        connector: 'native',
        decision: 'refused',
      }),
    ]);
    expect(rows[0].reason).toMatch(/Hard floor/);
  });

  it('denies a hard-floor MCP tool the backend loaded itself', async () => {
    const { resolver, rows } = setup(3);
    const result = await resolver.evaluate(request('mcp__bank__wire_funds', 'other'), vi.fn());
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(rows[0]).toMatchObject({ tool: 'bank__wire_funds', connector: 'bank', decision: 'refused' });
  });

  it('answers "cancelled" when a denied request offers no reject option', async () => {
    const { resolver } = setup(1);
    const result = await resolver.evaluate(
      request('Write a.md', 'edit', 'c1', undefined, [{ optionId: 'ok', name: 'OK', kind: 'allow_once' }]),
      vi.fn()
    );
    expect(result.outcome).toEqual({ outcome: 'cancelled' });
  });

  it('rung 2 holds a write for a person even in YOLO, offers no "allow always", never caches', async () => {
    const { resolver, rows, persist } = setup(2, { yolo: true });
    const ui = vi.fn<(d: PermissionUIData) => void>();
    const p1 = resolver.evaluate(request('Write proposal.md', 'edit', 'c1'), ui);
    expect(ui).toHaveBeenCalledOnce();
    expect(ui.mock.calls[0][0].autonomyHold).toBe(true);
    // allow_always would let the backend remember a rule and stop asking.
    expect(ui.mock.calls[0][0].options.map((o) => o.kind)).toEqual(['allow_once', 'reject_once']);
    expect(rows).toHaveLength(0);

    resolver.resolve('c1', 'allow');
    expect(await p1).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(persist).not.toHaveBeenCalled();
    expect(rows).toEqual([expect.objectContaining({ decision: 'allowed', rung: 2 })]);

    // Same call again: asked again, not served from the cache.
    const ui2 = vi.fn();
    const p2 = resolver.evaluate(request('Write proposal.md', 'edit', 'c2'), ui2);
    expect(ui2).toHaveBeenCalledOnce();
    resolver.resolve('c2', 'deny');
    await p2;
    expect(rows.at(-1)).toMatchObject({ decision: 'refused' });
  });

  it('an unattended rung-2 hold expires as a logged refusal', async () => {
    vi.useFakeTimers();
    try {
      const { resolver, rows } = setup(2, { holdDeadlineMs: 1000 });
      const p = resolver.evaluate(request('Write proposal.md', 'edit', 'c1'), vi.fn());
      vi.advanceTimersByTime(1000);
      expect(await p).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
      expect(rows).toEqual([expect.objectContaining({ decision: 'refused' })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hold in an ATTENDED session (team, channel, chat) is still bounded: 15 min -> logged refusal', async () => {
    vi.useFakeTimers();
    try {
      const { resolver, rows } = setup(2);
      const onExpired = vi.fn();
      (resolver as unknown as { onHoldExpired: unknown }).onHoldExpired = onExpired;
      const p = resolver.evaluate(request('Write proposal.md', 'edit', 'c1'), vi.fn());
      vi.advanceTimersByTime(AUTONOMY_HOLD_DEADLINE_MS - 1);
      expect(rows).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(await p).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
      expect(rows).toEqual([expect.objectContaining({ decision: 'refused' })]);
      // Reported as an ATTENDED expiry, so the notice (and the card removal)
      // can say what happened without calling it a scheduled run.
      expect(onExpired).toHaveBeenCalledWith(expect.objectContaining({ callId: 'c1', scheduled: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('rung 3 passes a write to the normal flow and records it', async () => {
    const { resolver, rows } = setup(3);
    const ui = vi.fn<(d: PermissionUIData) => void>();
    const p = resolver.evaluate(request('Write proposal.md', 'edit', 'c1'), ui);
    expect(ui.mock.calls[0][0].autonomyHold).toBeUndefined();
    resolver.resolve('c1', 'allow');
    await p;
    expect(rows).toEqual([expect.objectContaining({ decision: 'allowed', rung: 3, connector: 'native' })]);
  });

  it('reads pass unlogged at rung 1', async () => {
    const { resolver, rows } = setup(1, { yolo: true });
    const result = await resolver.evaluate(request('Read a.md', 'read'), vi.fn());
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    expect(rows).toHaveLength(0);
  });

  it('denies (logged) a held call whose only approval is "allow always"', async () => {
    const { resolver, rows } = setup(2);
    const ui = vi.fn();
    const result = await resolver.evaluate(
      request('Write a.md', 'edit', 'c1', undefined, [
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ]),
      ui
    );
    expect(ui).not.toHaveBeenCalled();
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(rows).toEqual([expect.objectContaining({ decision: 'refused' })]);
  });

  it('a shimmed server: rung-2 write denied once in the ledger; rung-3 write left to the shim to record', async () => {
    const rows: ApprovalRecord[] = [];
    const make = (rung: AutonomyRung) =>
      new PermissionResolver({
        autoApproveAll: true,
        gate: createAutonomyPermissionGate(
          { agent: 'custom:pack-warrior-estimator', rung, hardFloorKeywords: [], logPath: LOG },
          'claude',
          { append: (_p, row) => rows.push(row), shimmedMcpServers: ['warrior-ghl'] }
        ),
      });
    const call = () => request('mcp__warrior-ghl__ghl_create_contact', 'other');
    expect((await make(2).evaluate(call(), vi.fn())).outcome).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(rows).toHaveLength(1);
    expect((await make(3).evaluate(call(), vi.fn())).outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    expect(rows).toHaveLength(1);
  });

  it('strips mode-switch options above the rung', async () => {
    const { resolver } = setup(2);
    const ui = vi.fn<(d: PermissionUIData) => void>();
    void resolver.evaluate(
      request('Ready to code?', 'switch_mode', 'c1', undefined, [
        { optionId: 'bypassPermissions', name: 'Yes, bypass', kind: 'allow_always' },
        { optionId: 'acceptEdits', name: 'Yes, auto-accept edits', kind: 'allow_always' },
        { optionId: 'default', name: 'Yes, manually approve', kind: 'allow_once' },
        { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
      ]),
      ui
    );
    expect(ui.mock.calls[0][0].options.map((o) => o.optionId)).toEqual(['default', 'plan']);
    expect(ui.mock.calls[0][0].autonomyHold).toBe(true);
  });

  it("exempts Wayland's own team coordination tools, and only those", async () => {
    const rows: ApprovalRecord[] = [];
    const gate = createAutonomyPermissionGate(
      { agent: 'custom:pack-warrior-estimator', rung: 1, hardFloorKeywords: [], logPath: LOG },
      'claude',
      { append: (_p, row) => rows.push(row), internalMcpServers: ['wayland-team'] }
    );
    const resolver = new PermissionResolver({ autoApproveAll: true, gate });
    const internal = await resolver.evaluate(request('mcp__wayland-team__team_remove_member', 'other'), vi.fn());
    expect(internal.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    const external = await resolver.evaluate(request('mcp__other-team__team_send_message', 'other'), vi.fn());
    expect(external.outcome).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(rows).toHaveLength(1);
  });

  it('a resolver with no gate is unchanged (YOLO approves a delete)', async () => {
    const resolver = new PermissionResolver({ autoApproveAll: true });
    const result = await resolver.evaluate(request('rm -rf x', 'delete'), vi.fn());
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
  });
});
