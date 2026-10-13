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
import { ProcessAcpClient, withClaudeCodeOptions } from '@process/acp/infra/ProcessAcpClient';
import { resolveLadderedSessionMeta, verifyLadderedBridge } from '@process/services/jarvis/sessionAutonomy';

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
    await client.forkSession({ sessionId: 's-1', cwd: dir, ...(meta ? { meta } : {}) });
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
  it('sends _meta.claudeCode.options.settingSources on session/new AND session/load', async () => {
    const meta = await resolveLadderedSessionMeta('claude');
    expect(meta).toEqual({ claudeCode: { options: { settingSources: [] } } });
    const calls = await record(meta);
    expect(calls.map((c) => c.method)).toEqual(['session/new', 'session/load', 'session/new']);
    expect(calls[0].params._meta).toEqual(meta);
    expect(calls[1].params._meta).toEqual(meta);
    // The fork keeps the override next to its own `resume`.
    expect(calls[2].params._meta).toEqual({
      claudeCode: { options: { settingSources: [], resume: 's-1' } },
    });
  }, 20_000);

  it('a session without the ladder sends no _meta (today’s behaviour)', async () => {
    const calls = await record(undefined);
    expect(calls[0].params._meta).toBeUndefined();
    expect(calls[1].params._meta).toBeUndefined();
    // A plain fork carries only its resume option, exactly as before.
    expect(calls[2].params._meta).toEqual({ claudeCode: { options: { resume: 's-1' } } });
  }, 20_000);

  it('only Claude gets the settings override', async () => {
    expect(await resolveLadderedSessionMeta('codex')).toBeUndefined();
    expect(await resolveLadderedSessionMeta('qwen')).toBeUndefined();
  });
});

describe('laddered sessions load NO setting sources, wherever they run', () => {
  it('even in a workspace whose .claude/settings.json allow-lists everything', async () => {
    const ws = fs.mkdtempSync(path.join(dir, 'evil-'));
    fs.mkdirSync(path.join(ws, '.claude'));
    fs.writeFileSync(
      path.join(ws, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(*)'] } })
    );
    const meta = (await resolveLadderedSessionMeta('claude')) as { claudeCode: { options: Record<string, unknown> } };
    expect(meta.claudeCode.options.settingSources).toEqual([]);
  });
});

const init = (version?: string, name = '@agentclientprotocol/claude-agent-acp') => ({
  agentInfo: { name, ...(version ? { version } : {}) },
});

describe('verifyLadderedBridge - only a bridge verified to honour the override', () => {
  it.each(['0.74.0', '0.74.3', '0.80.1', '0.99.0'])('accepts claude-agent-acp %s', (version) => {
    expect(verifyLadderedBridge('claude', init(version))).toEqual({ ok: true });
  });
  it.each(['0.44.0', '0.73.9', '1.0.0', '2.1.0'])('refuses claude-agent-acp %s', (version) => {
    expect(verifyLadderedBridge('claude', init(version)).ok).toBe(false);
  });
  it('refuses another agent, a missing version and a missing initialize result', () => {
    expect(verifyLadderedBridge('claude', init('0.74.0', 'other')).ok).toBe(false);
    expect(verifyLadderedBridge('claude', init()).ok).toBe(false);
    expect(verifyLadderedBridge('claude', undefined).ok).toBe(false);
  });
  it('does not apply to backends without the settings override', () => {
    expect(verifyLadderedBridge('codex', undefined)).toEqual({ ok: true });
  });
});

describe('laddered + Flux: the scoped availableModels allowlist survives', () => {
  it('carries ONLY availableModels from the scoped CLAUDE_CONFIG_DIR as flag settings', async () => {
    const scoped = fs.mkdtempSync(path.join(dir, 'flux-claude-home-'));
    fs.writeFileSync(
      path.join(scoped, 'settings.json'),
      JSON.stringify({ availableModels: ['flux-auto'], permissions: { allow: ['Edit'], defaultMode: 'auto' } })
    );
    const meta = await resolveLadderedSessionMeta('claude', {}, scoped);
    expect(meta).toEqual({
      claudeCode: { options: { settingSources: [], settings: { availableModels: ['flux-auto'] } } },
    });
  });

  it('no scoped dir: no flag settings', async () => {
    const meta = (await resolveLadderedSessionMeta('claude')) as {
      claudeCode: { options: Record<string, unknown> };
    };
    expect(meta.claudeCode.options.settings).toBeUndefined();
  });
});

describe('withClaudeCodeOptions', () => {
  it('merges into claudeCode.options and keeps other _meta keys', () => {
    expect(
      withClaudeCodeOptions({ other: 1, claudeCode: { options: { settingSources: [] }, x: 2 } }, { resume: 'r' })
    ).toEqual({ other: 1, claudeCode: { x: 2, options: { settingSources: [], resume: 'r' } } });
    expect(withClaudeCodeOptions(undefined, { resume: 'r' })).toEqual({ claudeCode: { options: { resume: 'r' } } });
  });
});
