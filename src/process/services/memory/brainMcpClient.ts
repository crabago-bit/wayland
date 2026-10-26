/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ProcessConfig } from '@process/utils/initStorage';
import type { BrainTools } from './brainMemoryService';

type BrainEndpoint = { url: string; headers: Record<string, string> };

/** The enabled `brain` entry of the user's MCP server list, or null when there is none. */
export async function readBrainEndpoint(): Promise<BrainEndpoint | null> {
  const servers = (await ProcessConfig.get('mcp.config')) as unknown;
  if (!Array.isArray(servers)) return null;
  const brain = servers.find(
    (s) => (s as { name?: string }).name === 'brain' && (s as { enabled?: boolean }).enabled !== false
  ) as { transport?: { type?: string; url?: string; headers?: Record<string, string> } } | undefined;
  const t = brain?.transport;
  if (!t?.url || (t.type !== 'streamable_http' && t.type !== 'http')) return null;
  return { url: t.url, headers: t.headers ?? {} };
}

/**
 * A long-lived MCP client to the brain server. It reconnects once on a failed call so a
 * brain restart does not leave the Memory page broken until Wayland restarts.
 */
export class BrainMcpClient implements BrainTools {
  private client: Client | null = null;

  constructor(private readonly endpoint: BrainEndpoint) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'wayland-memory', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(this.endpoint.url), { requestInit: { headers: this.endpoint.headers } })
    );
    this.client = client;
    return client;
  }

  private async reset(): Promise<void> {
    const old = this.client;
    this.client = null;
    try {
      await old?.close();
    } catch {
      /* already closed */
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return await (await this.connect()).callTool({ name, arguments: args });
    } catch (first) {
      await this.reset();
      try {
        return await (await this.connect()).callTool({ name, arguments: args });
      } catch {
        throw first;
      }
    }
  }
}
