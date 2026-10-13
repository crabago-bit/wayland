/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The LIVE ACP projection (McpConfig.projectStorageConfig, used by AcpAgentV2)
 * must publish every connector of a laddered agent through the tool-filter
 * shim. Before this, only the legacy AcpAgent (never constructed in
 * production) did, so the ladder was never enforced.
 */

import { describe, expect, it } from 'vitest';
import { McpConfig, type McpConfigPublicationRequest } from '@process/acp/session/McpConfig';
import {
  TOOL_FILTER_HEADERS_ENV,
  TOOL_FILTER_SCRIPT,
  TOOL_FILTER_URL_ENV,
} from '@process/services/mcpServices/builtinMcpRuntime';
import type { ToolFilterSpawnAutonomy } from '@process/services/mcpServices/builtinMcpRuntime';
import { createMcpSessionDigestKey } from '@process/services/mcpServices/mcpSessionTruthGate';
import { wrapWCoreServersWithAutonomy } from '@process/agent/acp/mcpSessionConfig';
import type { IMcpServer } from '@/common/config/storage';

type Stdio = { name: string; command: string; args: string[]; env: { name: string; value: string }[] };

const autonomy: ToolFilterSpawnAutonomy = {
  agent: 'custom:pack-warrior-estimator',
  rung: 2,
  hardFloorKeywords: ['wire', 'payroll'],
  logPath: '/data/jarvis/approvals.jsonl',
};

const request = (over: Partial<McpConfigPublicationRequest> = {}): McpConfigPublicationRequest => ({
  publication: {
    generation: 'g',
    conversationId: 'c',
    backend: 'acp',
    sessionKey: createMcpSessionDigestKey(),
  },
  capabilities: { stdio: true, http: true, sse: true },
  ...over,
});

const stdio = (over: Partial<IMcpServer> = {}): IMcpServer =>
  ({
    id: 'ghl',
    name: 'warrior-ghl',
    enabled: true,
    source: 'custom',
    transport: { type: 'stdio', command: '/usr/bin/ghl-mcp', args: ['--stdio'], env: { GHL_TOKEN: 't' } },
    originalJson: '{}',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as IMcpServer;

const hosted = (type: 'http' | 'streamable_http' | 'sse', over: Partial<IMcpServer> = {}): IMcpServer =>
  ({
    id: `h-${type}`,
    name: `hosted-${type}`,
    enabled: true,
    source: 'library',
    transport: { type, url: 'https://connector.example/mcp', headers: { Authorization: 'Bearer secret' } },
    originalJson: '{}',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as IMcpServer;

function ladderArgs(args: string[]) {
  const at = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  return { rung: at('--rung'), agent: at('--agent'), log: at('--log'), floor: at('--floor') };
}

describe('McpConfig.projectStorageConfig - JARVIS autonomy ladder', () => {
  it('emits shim argv with --rung/--agent/--log/--floor for a pack agent stdio connector', () => {
    const projection = McpConfig.projectStorageConfig([stdio()], request({ autonomy }));
    const server = projection.servers[0] as Stdio;
    expect(server.args[0]).toContain(TOOL_FILTER_SCRIPT);
    expect(server.args).toContain('--allow-all');
    expect(ladderArgs(server.args)).toEqual({
      rung: ['2'],
      agent: ['custom:pack-warrior-estimator'],
      log: ['/data/jarvis/approvals.jsonl'],
      floor: ['wire', 'payroll'],
    });
    // The real server is what the shim spawns, after `--`.
    const sep = server.args.indexOf('--');
    expect(server.args.slice(sep + 1)).toEqual(['/usr/bin/ghl-mcp', '--stdio']);
    // The server's env still reaches it (the shim's child inherits).
    expect(server.env).toContainEqual({ name: 'GHL_TOKEN', value: 't' });
    // Receipts still record the connector as published.
    expect(projection.omissions).toEqual([]);
  });

  it('respects an explicit per-tool selection when it wraps', () => {
    const projection = McpConfig.projectStorageConfig(
      [stdio({ allowedTools: ['ghl_search_contact', 'ghl_create_contact'] })],
      request({ autonomy })
    );
    const args = (projection.servers[0] as Stdio).args;
    expect(args).not.toContain('--allow-all');
    expect(args.filter((_, i) => args[i - 1] === '--allow')).toEqual(['ghl_search_contact', 'ghl_create_contact']);
  });

  it.each(['http', 'streamable_http', 'sse'] as const)('bridges a hosted %s connector through the shim', (type) => {
    const projection = McpConfig.projectStorageConfig([hosted(type)], request({ autonomy }));
    const server = projection.servers[0] as Stdio & { type?: string; url?: string };
    expect(server.type).toBeUndefined();
    expect(server.url).toBeUndefined();
    expect(server.args[0]).toContain(TOOL_FILTER_SCRIPT);
    expect(server.args.slice(server.args.indexOf('--upstream'), server.args.indexOf('--upstream') + 3)).toEqual([
      '--upstream',
      type,
      '--url-env',
    ]);
    // The URL (which may embed a key) is in env, never argv.
    expect(server.args.join(' ')).not.toContain('connector.example');
    expect(server.env).toContainEqual({ name: TOOL_FILTER_URL_ENV, value: 'https://connector.example/mcp' });
    expect(ladderArgs(server.args).rung).toEqual(['2']);
    // Bearer token travels in env, never argv.
    expect(server.args.join(' ')).not.toContain('secret');
    expect(server.env).toContainEqual({
      name: TOOL_FILTER_HEADERS_ENV,
      value: JSON.stringify({ Authorization: 'Bearer secret' }),
    });
  });

  it('bridges a hosted connector even when the agent lacks http capability (stdio is enough)', () => {
    const projection = McpConfig.projectStorageConfig(
      [hosted('http')],
      request({ autonomy, capabilities: { stdio: true, http: false, sse: false } })
    );
    expect(projection.servers).toHaveLength(1);
  });

  it('withholds a hosted connector (fail closed) when there is no stdio transport to bridge through', () => {
    const projection = McpConfig.projectStorageConfig(
      [hosted('http')],
      request({ autonomy, capabilities: { stdio: false, http: true, sse: true } })
    );
    expect(projection.servers).toEqual([]);
    expect(projection.omissions[0].reason).toMatch(/Autonomy ladder/);
  });

  it('an agent with no configured rung keeps today’s raw descriptors', () => {
    const projection = McpConfig.projectStorageConfig([stdio(), hosted('http')], request());
    const [local, remote] = projection.servers as Array<Stdio & { type?: string; url?: string }>;
    expect(local.args.join(' ')).not.toContain(TOOL_FILTER_SCRIPT);
    expect(local.args).not.toContain('--rung');
    expect(remote).toMatchObject({ type: 'http', url: 'https://connector.example/mcp' });
  });
});

describe('wrapWCoreServersWithAutonomy - Wayland Core config.toml path', () => {
  it('rewrites stdio and hosted connectors into shim stdio launches', () => {
    const [local, remote] = wrapWCoreServersWithAutonomy([stdio(), hosted('sse')], autonomy);
    expect(local.transport.type).toBe('stdio');
    const localArgs = (local.transport as { args: string[] }).args;
    expect(ladderArgs(localArgs).agent).toEqual(['custom:pack-warrior-estimator']);
    expect(localArgs.slice(localArgs.indexOf('--') + 1)).toEqual(['/usr/bin/ghl-mcp', '--stdio']);
    expect(remote.transport.type).toBe('stdio');
    const remoteArgs = (remote.transport as { args: string[] }).args;
    expect(remoteArgs).toContain('--url-env');
    expect((remote.transport as { env: Record<string, string> }).env[TOOL_FILTER_URL_ENV]).toBe(
      'https://connector.example/mcp'
    );
    expect((remote.transport as { env: Record<string, string> }).env[TOOL_FILTER_HEADERS_ENV]).toBeDefined();
    // Identity and selection metadata are preserved.
    expect(local.name).toBe('warrior-ghl');
    expect(remote.id).toBe('h-sse');
  });
});
