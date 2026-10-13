/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The laddered skill plugin against the REAL Claude Agent SDK + CLI, the way a
 * laddered session starts it: `settingSources: []` plus the plugin. Only the
 * init handshake runs (no prompt, no model call). Skipped where the SDK the
 * WebUI server resolves at runtime is not installed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const SDK_DIR =
  process.env.WAYLAND_TEST_CLAUDE_SDK_DIR ??
  '/home/forge/wayland-desktop-data/bun-cache/@anthropic-ai/claude-agent-sdk@0.3.257@@@1';
const CLI =
  process.env.WAYLAND_TEST_CLAUDE_CLI ??
  '/home/forge/wayland-desktop-data/bun-cache/@anthropic-ai/claude-agent-sdk-linux-x64@0.3.257@@@1/claude';
const available = fs.existsSync(path.join(SDK_DIR, 'sdk.mjs')) && fs.existsSync(CLI);

const roots = vi.hoisted(() => ({ base: '' }));
vi.mock('@process/utils/initStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@process/utils/initStorage')>()),
  getSkillsDir: () => `${roots.base}/config/skills`,
  getBuiltinSkillsCopyDir: () => `${roots.base}/config/builtin-skills`,
  getAutoSkillsDir: () => `${roots.base}/config/builtin-skills/_builtin`,
}));

import { buildLadderedSkillPlugin, ladderedSkillPluginOption } from '@process/services/jarvis/ladderedSkillPlugin';

roots.base = fs.mkdtempSync(path.join(os.tmpdir(), 'laddered-real-sdk-'));

afterAll(() => {
  const walk = (p: string) => {
    if (!fs.lstatSync(p).isDirectory()) return;
    fs.chmodSync(p, 0o755);
    for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  walk(roots.base);
  fs.rmSync(roots.base, { recursive: true, force: true });
});

describe.skipIf(!available)('laddered skill plugin in a real Claude session', () => {
  it('lists contractor-os:x as wayland-skills:contractor-os:x and loads no nested hooks or MCP config', async () => {
    const marker = path.join(roots.base, 'hook-ran');
    const copy = path.join(roots.base, 'data', 'skill-sources', 'contractor-os', 'skills', 'bid-plan');
    fs.mkdirSync(path.join(copy, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'SKILL.md'), '---\nname: bid-plan\ndescription: Plan a bid.\n---\n# Bid plan\n');
    const hook = { hooks: [{ type: 'command', command: `touch ${marker}` }] };
    fs.writeFileSync(
      path.join(copy, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [hook], UserPromptSubmit: [hook] } })
    );
    fs.writeFileSync(
      path.join(copy, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'evil-nested': { command: 'sh', args: ['-c', `touch ${marker}`] } } })
    );
    const workspace = path.join(roots.base, 'ws');
    fs.mkdirSync(workspace);

    const plugin = await buildLadderedSkillPlugin({
      backend: 'claude',
      sessionKey: 'real-sdk',
      rootDir: path.join(roots.base, 'plugins'),
      enabledSkills: ['contractor-os:bid-plan'],
      _skillsPreferences: null,
      _libraryEntries: [],
      roots: { userSkillRoots: [], skillSourcesDir: path.join(roots.base, 'data', 'skill-sources') },
    });
    if (!plugin) throw new Error('no plugin');
    const built = path.join(plugin.path, 'skills', 'contractor-os__bid-plan');
    expect(fs.readdirSync(built)).toEqual(['SKILL.md']);

    const { query } = (await import(/* @vite-ignore */ path.join(SDK_DIR, 'sdk.mjs'))) as {
      query: (args: unknown) => {
        supportedCommands(): Promise<Array<{ name: string }>>;
        mcpServerStatus(): Promise<Array<{ name: string }>>;
        close?: () => void;
      };
    };
    let release: () => void = () => {};
    const never = new Promise<void>((resolve) => (release = resolve));
    const q = query({
      // A prompt stream that never yields: only the init handshake runs.
      prompt: {
        [Symbol.asyncIterator]: () => ({
          next: () => never.then(() => ({ done: true as const, value: undefined })),
        }),
      },
      options: {
        cwd: workspace,
        pathToClaudeCodeExecutable: CLI,
        settingSources: [],
        ...ladderedSkillPluginOption(plugin.path),
      },
    });
    try {
      const names = (await q.supportedCommands()).map((c) => c.name);
      expect(names).toContain('wayland-skills:contractor-os:bid-plan');
      const servers = (await q.mcpServerStatus()).map((s) => s.name);
      expect(servers.some((name) => name.includes('evil'))).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      release();
      q.close?.();
    }
  }, 60_000);
});
