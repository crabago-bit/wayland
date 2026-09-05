/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The autonomy ladder must reach HOSTED connectors, not only stdio ones.
 *
 * A rung and a hard floor are rules about `tools/call`, and no engine wire
 * carries either - which is the whole reason the stdio path interposes the
 * filtering shim. Hosted http/streamable_http/sse connectors were handed to the
 * engine as raw URLs, so the engine connected to them itself and neither the
 * rung nor the floor applied, while the settings card told the user the floor
 * held on any connector. These tests pin the bridge that closes that: the engine
 * receives a STDIO descriptor pointing at the shim, never the endpoint.
 */

import { describe, it, expect } from 'vitest';
import { buildAcpSessionMcpServers } from '@process/agent/acp/mcpSessionConfig';
import { TOOL_FILTER_HEADERS_ENV } from '@process/services/mcpServices/builtinMcpRuntime';
import type { IMcpServer } from '@/common/config/storage';
import type { ToolFilterSpawnAutonomy } from '@process/services/mcpServices/builtinMcpRuntime';

const caps = { stdio: true, http: true, sse: true };

const autonomy: ToolFilterSpawnAutonomy = {
  agent: 'claude',
  rung: 2,
  hardFloorKeywords: ['wire'],
  logPath: '/data/jarvis/approvals.jsonl',
};

const hosted = (over: Partial<IMcpServer> = {}): IMcpServer =>
  ({
    id: 'h',
    name: 'hosted',
    enabled: true,
    status: 'connected',
    transport: {
      type: 'streamable_http',
      url: 'https://connector.example/mcp',
      headers: { Authorization: 'Bearer secret-token' },
    },
    originalJson: '{}',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as IMcpServer;

/** The stdio descriptor the engine is handed for a bridged hosted connector. */
function bridged(servers: IMcpServer[], capabilities = caps, ladder: ToolFilterSpawnAutonomy | undefined = autonomy) {
  const out = buildAcpSessionMcpServers(servers, capabilities, undefined, false, ladder);
  return out[0] as {
    type?: string;
    name: string;
    command: string;
    args: string[];
    env: { name: string; value: string }[];
  };
}

describe('hosted connectors are bridged through the tool-filter shim', () => {
  it('hands the engine a stdio descriptor that spawns the shim with the URL', () => {
    const descriptor = bridged([hosted()]);
    expect(descriptor.type).toBe('stdio');
    expect(descriptor.name).toBe('hosted');
    // The URL is the SHIM's argument. The engine spawns the shim and so does
    // see it on argv - that is fine, and the reason it is on argv rather than
    // in the environment is that a stuck connector has to be diagnosable. What
    // matters is that the descriptor is not the endpoint itself: a raw URL here
    // meant the engine connected directly and no verdict ever ran.
    expect(descriptor.args).toContain('https://connector.example/mcp');
    expect(descriptor.args.join(' ')).toContain('builtin-mcp-tool-filter');
  });

  it('passes the rung, the agent, the ledger path and the operator floor to the shim', () => {
    const args = bridged([hosted()]).args;
    expect(args).toEqual(expect.arrayContaining(['--rung', '2', '--agent', 'claude']));
    expect(args).toEqual(expect.arrayContaining(['--log', '/data/jarvis/approvals.jsonl']));
    expect(args).toEqual(expect.arrayContaining(['--floor', 'wire']));
  });

  it('names the upstream kind so sse gets the right client', () => {
    expect(bridged([hosted()]).args).toEqual(expect.arrayContaining(['--upstream', 'streamable_http']));
    const sse = hosted({ transport: { type: 'sse', url: 'https://connector.example/sse' } } as Partial<IMcpServer>);
    expect(bridged([sse]).args).toEqual(expect.arrayContaining(['--upstream', 'sse']));
  });

  it('carries request headers in the ENVIRONMENT, never on argv', () => {
    const descriptor = bridged([hosted()]);
    // argv is readable from `ps` by anyone on the box, and a hosted connector's
    // bearer token lives in its headers.
    expect(descriptor.args.join(' ')).not.toContain('secret-token');
    const header = descriptor.env.find((entry) => entry.name === TOOL_FILTER_HEADERS_ENV);
    expect(header?.value).toBe('{"Authorization":"Bearer secret-token"}');
  });

  it('passes --allow-all when there is no per-tool selection, not an empty list', () => {
    // `[]` would mean "allow nothing" and silently mute an unscoped connector.
    expect(bridged([hosted()]).args).toContain('--allow-all');
  });

  it('threads an explicit per-tool selection through as one --allow each', () => {
    const args = bridged([hosted({ allowedTools: ['alpha', 'beta'] })]).args;
    expect(args).not.toContain('--allow-all');
    expect(args).toEqual(expect.arrayContaining(['--allow', 'alpha', '--allow', 'beta']));
  });

  it('leaves a hosted connector unbridged when there is no ladder and no selection', () => {
    const out = buildAcpSessionMcpServers([hosted()], caps, undefined, false, undefined);
    expect(out[0]).toMatchObject({ type: 'http', url: 'https://connector.example/mcp' });
  });

  it('WITHHOLDS a hosted connector when there is a ladder but no stdio to bridge through', () => {
    // Fail closed: registering it raw would hand the engine an unfiltered
    // endpoint while the UI promises the floor applies to it.
    const out = buildAcpSessionMcpServers(
      [hosted()],
      { stdio: false, http: true, sse: true },
      undefined,
      false,
      autonomy
    );
    expect(out).toEqual([]);
  });
});
