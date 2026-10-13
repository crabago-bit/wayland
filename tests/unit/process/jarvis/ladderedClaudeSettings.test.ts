/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A laddered Claude session must not load the user's Claude Code settings:
 * their `permissions.allow` rules, `defaultMode` and hooks approve calls inside
 * the CLI without ever sending session/request_permission, i.e. past the gate.
 *
 * The bridge spreads `_meta.claudeCode.options` into the SDK query, so the
 * session is started with `settingSources: ['project']`. These tests pin the
 * wire: the real ProcessAcpClient against a fake ACP agent that records what it
 * received on session/new and session/load.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessAcpClient } from '@process/acp/infra/ProcessAcpClient';
import { LADDERED_CLAUDE_SESSION_META, ladderedSessionMeta } from '@process/services/jarvis/sessionAutonomy';

const AGENT = `
const fs = require('node:fs');
const out = process.env.RECORD;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === 'session/new' || msg.method === 'session/load') {
      fs.appendFileSync(out, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');
    }
    let result = {};
    if (msg.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    if (msg.method === 'session/new') result = { sessionId: 's-1' };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
setInterval(() => {}, 60000);
`;

const handlers = {
  onSessionUpdate: async () => {},
  onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) as never,
  onReadTextFile: async () => ({ content: '' }),
  onWriteTextFile: async () => ({}),
} as never;

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-meta-'));
  fs.writeFileSync(path.join(dir, 'agent.cjs'), AGENT);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function record(meta?: Record<string, unknown>) {
  const out = path.join(dir, `rec-${Math.random().toString(36).slice(2)}.jsonl`);
  const client = new ProcessAcpClient(
    async () =>
      spawn(process.execPath, [path.join(dir, 'agent.cjs')], { stdio: 'pipe', env: { ...process.env, RECORD: out } }),
    { backend: 'claude', handlers }
  );
  try {
    await client.start();
    await client.createSession({ cwd: dir, ...(meta ? { metadata: meta } : {}) });
    await client.loadSession({ sessionId: 's-1', cwd: dir, ...(meta ? { metadata: meta } : {}) });
  } finally {
    await client.close().catch(() => {});
  }
  return fs
    .readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

describe('laddered Claude sessions start without user/local Claude Code settings', () => {
  it('sends _meta.claudeCode.options.settingSources = ["project"] on session/new AND session/load', async () => {
    const meta = ladderedSessionMeta('claude');
    expect(meta).toEqual({ claudeCode: { options: { settingSources: ['project'] } } });
    const calls = await record(meta);
    expect(calls.map((c) => c.method)).toEqual(['session/new', 'session/load']);
    for (const call of calls) {
      expect(call.params._meta).toEqual(LADDERED_CLAUDE_SESSION_META);
    }
  }, 20_000);

  it('a session without the ladder sends no _meta (today’s behaviour)', async () => {
    const calls = await record(undefined);
    for (const call of calls) expect(call.params._meta).toBeUndefined();
  }, 20_000);

  it('only Claude gets the settings override', () => {
    expect(ladderedSessionMeta('codex')).toBeUndefined();
    expect(ladderedSessionMeta('qwen')).toBeUndefined();
  });
});
