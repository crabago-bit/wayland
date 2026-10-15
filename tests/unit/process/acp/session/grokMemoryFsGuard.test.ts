/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Grok Build reads and edits its cross-session memory (`$GROK_HOME/memory-v2`)
 * through the client fs, and the workspace confinement refused it ("Path not
 * allowed: ~/.grok/memory-v2/workspaces/<slug>/topics/….md"), so Grok lost its
 * memory. memory-v2 is now an extra readable AND writable root for Grok; the
 * rest of the Grok home stays out, and its credentials are denied even when
 * the workspace itself contains them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpSession } from '@process/acp/session/AcpSession';
import { grokFsRoots, grokHomeDir } from '@process/agent/grok/fsRoots';
import type { AgentConfig, ProtocolHandlers, SessionCallbacks } from '@process/acp/types';

const SESSION = '01a13b70-0c54-7a30-b5b9-c3697e27ba5e';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A home with a Grok home (memory, config, credentials) and a chat workspace. */
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-memory-guard-')));
  roots.push(root);
  const grokHome = path.join(root, '.grok');
  const topics = path.join(grokHome, 'memory-v2', 'workspaces', 'gw-build-1-55051829', 'topics');
  fs.mkdirSync(topics, { recursive: true });
  fs.writeFileSync(path.join(topics, 'openconstructionerp-production.md'), '# OCE production');
  fs.writeFileSync(path.join(grokHome, 'auth.json'), '{"token":"secret"}');
  fs.writeFileSync(path.join(grokHome, 'auth.json.bak-20260905'), '{"token":"old"}');
  fs.writeFileSync(path.join(grokHome, 'config.toml'), 'x = 1');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace);
  return { root, grokHome, topics, workspace };
}

function build(config: Partial<AgentConfig>) {
  const callbacks = {
    onMessage: vi.fn(),
    onSessionId: vi.fn(),
    onStatusChange: vi.fn(),
    onConfigUpdate: vi.fn(),
    onModelUpdate: vi.fn(),
    onModeUpdate: vi.fn(),
    onContextUsage: vi.fn(),
    onPermissionRequest: vi.fn(),
    onSignal: vi.fn(),
  } satisfies SessionCallbacks;
  const session = new AcpSession(
    { agentBackend: 'grok', agentSource: 'builtin', agentId: 'conv-1', ...config } as AgentConfig,
    () => ({}) as never,
    callbacks
  );
  return (session as unknown as { buildProtocolHandlers(): ProtocolHandlers }).buildProtocolHandlers();
}

const read = (handlers: ProtocolHandlers, p: string) => handlers.onReadTextFile!({ sessionId: SESSION, path: p });
const write = (handlers: ProtocolHandlers, p: string, content = 'x') =>
  handlers.onWriteTextFile!({ sessionId: SESSION, path: p, content });

describe('grokFsRoots', () => {
  it('opens only memory-v2 and denies the credentials', () => {
    const roots = grokFsRoots({ GROK_HOME: '/srv/grok' });
    expect(roots.readOnlyRoots).toEqual(['/srv/grok/memory-v2']);
    expect(roots.writableRoots).toEqual(['/srv/grok/memory-v2']);
    expect(roots.deniedPaths).toEqual(['/srv/grok/auth.json', '/srv/grok/auth']);
  });

  it('defaults to ~/.grok, ignores a relative GROK_HOME, and denies a GROK_AUTH_PATH override', () => {
    const saved = { home: process.env.GROK_HOME, auth: process.env.GROK_AUTH_PATH };
    delete process.env.GROK_HOME;
    delete process.env.GROK_AUTH_PATH;
    try {
      expect(grokHomeDir({})).toBe(path.join(os.homedir(), '.grok'));
      expect(grokHomeDir({ GROK_HOME: 'rel/grok' })).toBe(path.join(os.homedir(), '.grok'));
      expect(grokFsRoots({ GROK_AUTH_PATH: '/keys/grok.json' }).deniedPaths).toContain('/keys/grok.json');
    } finally {
      if (saved.home !== undefined) process.env.GROK_HOME = saved.home;
      if (saved.auth !== undefined) process.env.GROK_AUTH_PATH = saved.auth;
    }
  });
});

describe('AcpSession fs guard: Grok memory', () => {
  it('reads and writes memory topics under the Grok memory root', async () => {
    const { grokHome, topics, workspace } = fixture();
    const handlers = build({ cwd: workspace, ...grokFsRoots({ GROK_HOME: grokHome }) });
    const topic = path.join(topics, 'openconstructionerp-production.md');

    await expect(read(handlers, topic)).resolves.toEqual({ content: '# OCE production' });
    await expect(write(handlers, topic, '# updated')).resolves.toEqual({});
    expect(fs.readFileSync(topic, 'utf8')).toBe('# updated');
    const inbox = path.join(grokHome, 'memory-v2', 'global', 'observations', '_inbox');
    fs.mkdirSync(inbox, { recursive: true });
    await expect(write(handlers, path.join(inbox, 'note.md'), 'n')).resolves.toEqual({});
  });

  it('keeps the rest of the Grok home out, for reads and writes', async () => {
    const { grokHome, workspace } = fixture();
    const handlers = build({ cwd: workspace, ...grokFsRoots({ GROK_HOME: grokHome }) });

    await expect(read(handlers, path.join(grokHome, 'config.toml'))).rejects.toThrow('Path not allowed');
    await expect(write(handlers, path.join(grokHome, 'config.toml'))).rejects.toThrow('Path not allowed');
    await expect(read(handlers, path.join(grokHome, 'auth.json'))).rejects.toThrow('Path not allowed');
    expect(fs.readFileSync(path.join(grokHome, 'config.toml'), 'utf8')).toBe('x = 1');
  });

  it('never serves the credentials, even from a workspace that contains them or via a memory symlink', async () => {
    const { root, grokHome, topics } = fixture();
    // A chat opened on the home directory: the Grok home is inside the workspace.
    const handlers = build({ cwd: root, ...grokFsRoots({ GROK_HOME: grokHome }) });
    fs.symlinkSync(path.join(grokHome, 'auth.json'), path.join(topics, 'leak.md'));

    await expect(read(handlers, path.join(grokHome, 'auth.json'))).rejects.toThrow('Path not allowed');
    await expect(read(handlers, path.join(grokHome, 'auth.json.bak-20260905'))).rejects.toThrow('Path not allowed');
    await expect(read(handlers, path.join(topics, 'leak.md'))).rejects.toThrow('Path not allowed');
    await expect(write(handlers, path.join(grokHome, 'auth.json'), '{}')).rejects.toThrow('Path not allowed');
    expect(fs.readFileSync(path.join(grokHome, 'auth.json'), 'utf8')).toBe('{"token":"secret"}');
    // The rest of that workspace is unaffected.
    await expect(read(handlers, path.join(grokHome, 'config.toml'))).resolves.toEqual({ content: 'x = 1' });
  });

  it('a read-only root is still not writable', async () => {
    const { grokHome, topics, workspace } = fixture();
    const handlers = build({ cwd: workspace, readOnlyRoots: [path.join(grokHome, 'memory-v2')] });
    await expect(write(handlers, path.join(topics, 'openconstructionerp-production.md'))).rejects.toThrow(
      'Path not allowed'
    );
  });
});
