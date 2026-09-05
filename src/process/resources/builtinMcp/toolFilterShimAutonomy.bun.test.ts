/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// src/process/resources/builtinMcp/toolFilterShimAutonomy.bun.test.ts
// Run with: bun test src/process/resources/builtinMcp/toolFilterShimAutonomy.bun.test.ts
//
// The JARVIS autonomy ladder, at the only layer where it is real: the shim's
// `tools/call` path. A rung that is merely displayed in settings is not a rung -
// these tests assert that a refused call NEVER reaches upstream, that the hard
// floor outranks rung 4, and that reads pass at rung 1.

import { describe, expect, it } from 'bun:test';

import { createToolFilter } from './toolFilterShim';
import { parseShimArgv } from './toolFilterShimEntry';
import type { ApprovalRecord } from '../../services/jarvis/approvalsLog';
import { DEFAULT_AUTONOMY_RUNG, type AutonomyRung } from '../../../common/jarvis/autonomy';

type Msg = Record<string, unknown>;

/** Drive one `tools/call` through the filter and report what happened. */
function callTool(
  toolName: string,
  rung: AutonomyRung,
  hardFloorKeywords: readonly string[] = []
): { toEngine: Msg[]; toUpstream: Msg[]; ledger: ApprovalRecord[] } {
  const toEngine: Msg[] = [];
  const toUpstream: Msg[] = [];
  const ledger: ApprovalRecord[] = [];
  const filter = createToolFilter({
    allowed: [],
    allowAll: true,
    autonomy: { agent: 'claude', rung, hardFloorKeywords, onDecision: (r) => ledger.push(r) },
    sendToEngine: (m) => toEngine.push(m),
    sendToUpstream: (m) => toUpstream.push(m),
  });
  filter.fromEngine({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: toolName } });
  return { toEngine, toUpstream, ledger };
}

function errorMessageOf(message: Msg): string {
  const error = message.error as { message?: string } | undefined;
  return error?.message ?? '';
}

describe('autonomy rungs in the tool filter', () => {
  it('refuses a write tool at rung 1 and 2 without forwarding it', () => {
    for (const rung of [1, 2] as const) {
      const { toEngine, toUpstream } = callTool('slack__send_message', rung);
      expect(toUpstream).toHaveLength(0);
      expect(toEngine).toHaveLength(1);
      expect(errorMessageOf(toEngine[0])).toBe(`Requires approval (autonomy rung ${rung}). Draft it and ask.`);
    }
  });

  it('does not answer "method not found" for a refused write tool', () => {
    // The tool exists and would work a rung up. Claiming it is absent would tell
    // the engine to give up instead of drafting.
    const { toEngine } = callTool('gmail__create_draft', 1);
    expect((toEngine[0].error as { code: number }).code).not.toBe(-32601);
  });

  it('allows a write tool at rung 3 and 4', () => {
    for (const rung of [3, 4] as const) {
      const { toEngine, toUpstream } = callTool('erpnext__update_customer', rung);
      expect(toEngine).toHaveLength(0);
      expect(toUpstream).toHaveLength(1);
      expect(toUpstream[0].method).toBe('tools/call');
    }
  });

  it('passes read/list/get/search tools at every rung', () => {
    for (const name of ['slack__read_channel', 'erpnext__list_items', 'gmail__get_message', 'apollo__search']) {
      for (const rung of [1, 2, 3, 4] as const) {
        const { toUpstream, ledger } = callTool(name, rung);
        expect(toUpstream).toHaveLength(1);
        // Reads are not ledger events - burying refusals under every directory
        // listing would make the ledger unreadable.
        expect(ledger).toHaveLength(0);
      }
    }
  });

  it('refuses the hard floor at rung 4, where no rung can buy past it', () => {
    for (const name of ['stripe__transfer_funds', 'gusto__run_payroll', 'erpnext__doc_delete', 'docusign__sign']) {
      const { toEngine, toUpstream } = callTool(name, 4);
      expect(toUpstream).toHaveLength(0);
      expect(errorMessageOf(toEngine[0])).toContain('Hard floor');
    }
  });

  it('honours extra hard-floor keywords from the operator notes', () => {
    const { toUpstream: withoutFloor } = callTool('ghl__book_appointment', 4);
    expect(withoutFloor).toHaveLength(1);
    const { toEngine, toUpstream } = callTool('ghl__book_appointment', 4, ['appointment']);
    expect(toUpstream).toHaveLength(0);
    expect(errorMessageOf(toEngine[0])).toContain('Hard floor');
  });

  it('records refusals and allowed write calls, with the connector split out', () => {
    const refused = callTool('slack__send_message', 1).ledger;
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      agent: 'claude',
      rung: 1,
      tool: 'slack__send_message',
      connector: 'slack',
      decision: 'refused',
    });

    const allowed = callTool('slack__send_message', 3).ledger;
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ rung: 3, decision: 'allowed', connector: 'slack' });
  });

  it('drops a refused notification (no id) instead of answering it', () => {
    const toEngine: Msg[] = [];
    const toUpstream: Msg[] = [];
    const filter = createToolFilter({
      allowed: [],
      allowAll: true,
      autonomy: { agent: 'wcore', rung: 1, hardFloorKeywords: [] },
      sendToEngine: (m) => toEngine.push(m),
      sendToUpstream: (m) => toUpstream.push(m),
    });
    filter.fromEngine({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'slack__send_message' } });
    expect(toEngine).toHaveLength(0);
    expect(toUpstream).toHaveLength(0);
  });

  it('leaves tools/list unfiltered under allow-all, so an agent can still draft', () => {
    const toEngine: Msg[] = [];
    const filter = createToolFilter({
      allowed: [],
      allowAll: true,
      autonomy: { agent: 'claude', rung: 1, hardFloorKeywords: [] },
      sendToEngine: (m) => toEngine.push(m),
      sendToUpstream: () => undefined,
    });
    filter.fromEngine({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    filter.fromUpstream({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'slack__send_message' }, { name: 'slack__read_channel' }] },
    });
    const result = toEngine[0].result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name)).toEqual(['slack__send_message', 'slack__read_channel']);
  });

  it('still enforces an explicit per-tool selection alongside the ladder', () => {
    const toEngine: Msg[] = [];
    const toUpstream: Msg[] = [];
    const filter = createToolFilter({
      allowed: ['slack__read_channel'],
      autonomy: { agent: 'claude', rung: 4, hardFloorKeywords: [] },
      sendToEngine: (m) => toEngine.push(m),
      sendToUpstream: (m) => toUpstream.push(m),
    });
    filter.fromEngine({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slack__list_channels' } });
    expect(toUpstream).toHaveLength(0);
    expect((toEngine[0].error as { code: number }).code).toBe(-32601);
  });
});

describe('shim argv for the ladder', () => {
  it('parses the ladder flags', () => {
    const parsed = parseShimArgv([
      '--allow-all',
      '--rung',
      '3',
      '--agent',
      'claude',
      '--floor',
      'appointment',
      '--floor',
      'bid',
      '--log',
      '/data/jarvis/approvals.jsonl',
      '--',
      'node',
      'server.js',
    ]);
    expect(parsed).toEqual({
      allowed: [],
      allowAll: true,
      rung: 3,
      agent: 'claude',
      hardFloorKeywords: ['appointment', 'bid'],
      logPath: '/data/jarvis/approvals.jsonl',
      command: 'node',
      args: ['server.js'],
    });
  });

  it('still refuses an empty allowlist that did not say --allow-all', () => {
    expect(parseShimArgv(['--rung', '2', '--', 'node', 'server.js'])).toBeNull();
  });

  it('clamps an out-of-range rung to the default rather than trusting it', () => {
    expect(parseShimArgv(['--allow-all', '--rung', '9', '--', 'node', 's.js'])?.rung).toBe(DEFAULT_AUTONOMY_RUNG);
  });

  it('keeps an explicitly stored rung 1, which the default no longer is', () => {
    expect(parseShimArgv(['--allow-all', '--rung', '1', '--', 'node', 's.js'])?.rung).toBe(1);
  });

  it('refuses a trailing value-taking flag instead of running unfiltered', () => {
    expect(parseShimArgv(['--allow-all', '--', 'node'])).not.toBeNull();
    expect(parseShimArgv(['--allow', 'a', '--rung', '--', 'node'])).toBeNull();
  });
});
