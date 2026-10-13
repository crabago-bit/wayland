/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End to end (as far as a unit run can go): the descriptor the LIVE projection
 * emits for a pack agent is spawned against the REAL tool-filter shim, bundled
 * exactly as `scripts/build-mcp-servers.js` bundles it, in front of a fake MCP
 * server. A rung-3 write call must reach the server and land an `allowed` line
 * in approvals.jsonl; a hard-floor call must be refused, never reach the
 * server, and land a `refused` line.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { McpConfig } from '@process/acp/session/McpConfig';
import { createMcpSessionDigestKey } from '@process/services/mcpServices/mcpSessionTruthGate';
import type { IMcpServer } from '@/common/config/storage';

const ROOT = path.resolve(__dirname, '../../../..');

/** A minimal line-delimited JSON-RPC MCP server that records every call it gets. */
const FAKE_SERVER = `
const fs = require('node:fs');
const seen = process.argv[2];
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'tools/call') fs.appendFileSync(seen, msg.params.name + '\\n');
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
    }
  }
});
`;

let dir: string;
let shimBundle: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-shim-e2e-'));
  shimBundle = path.join(dir, 'builtin-mcp-tool-filter.js');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/process/resources/builtinMcp/toolFilterShimEntry.ts')],
    outfile: shimBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'bun:sqlite'],
    tsconfig: path.join(ROOT, 'tsconfig.json'),
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(dir, 'fake-server.cjs'), FAKE_SERVER);
}, 60_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rpc(child: ChildProcessWithoutNullStreams, id: number, name: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`no reply to ${name}`)), 10_000);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === id) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(msg);
            return;
          }
        } catch {
          // partial line
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })}\n`
    );
  });
}

describe('autonomy ladder - live projection argv through the real shim', () => {
  it('a rung-3 pack agent: write allowed + logged, hard floor refused + logged', async () => {
    const logPath = path.join(dir, 'jarvis', 'approvals.jsonl');
    const seenPath = path.join(dir, 'seen.txt');
    const server = {
      id: 'erp',
      name: 'erp',
      enabled: true,
      source: 'custom',
      transport: { type: 'stdio', command: process.execPath, args: [path.join(dir, 'fake-server.cjs'), seenPath] },
      originalJson: '{}',
      createdAt: 1,
      updatedAt: 1,
    } as IMcpServer;

    const projection = McpConfig.projectStorageConfig([server], {
      publication: { generation: 'g', conversationId: 'c', backend: 'acp', sessionKey: createMcpSessionDigestKey() },
      capabilities: { stdio: true, http: false, sse: false },
      autonomy: { agent: 'custom:pack-warrior-estimator', rung: 3, hardFloorKeywords: [], logPath },
    });
    const descriptor = projection.servers[0] as { command: string; args: string[] };
    expect(descriptor.args[0]).toMatch(/builtin-mcp-tool-filter\.js$/);

    // Exactly the emitted argv, with the script path pointed at the fresh bundle
    // (the packaged copy lives under out/main, which a unit checkout lacks).
    const child = spawn(process.execPath, [shimBundle, ...descriptor.args.slice(1)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    try {
      const write = await rpc(child, 1, 'erp_create_estimate');
      expect(write.error).toBeUndefined();
      const floored = await rpc(child, 2, 'run_payroll');
      expect((floored.error as { code: number }).code).toBe(-32000);
    } finally {
      child.stdin.end();
      child.kill();
    }

    const rows = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toEqual([
      expect.objectContaining({
        agent: 'custom:pack-warrior-estimator',
        rung: 3,
        tool: 'erp_create_estimate',
        decision: 'allowed',
      }),
      expect.objectContaining({ tool: 'run_payroll', decision: 'refused' }),
    ]);
    // The refused call never reached the server.
    expect(fs.readFileSync(seenPath, 'utf8').trim().split('\n')).toEqual(['erp_create_estimate']);
  }, 30_000);
});
