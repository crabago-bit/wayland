/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { CLAUDE_ACP_NPX_PACKAGE, CODEX_ACP_NPX_PACKAGE } from '@/common/types/acpTypes';
import { findSshHost, type SshHost } from './sshConfig';
import { shellQuote } from './sshRemoteBrowse';

/** A resolved process launch: what to hand to `child_process.spawn`. */
export type SshSpawn = { command: 'ssh'; args: string[]; env: NodeJS.ProcessEnv };

/**
 * The argv to run on the remote host for a given backend, or undefined when the
 * backend cannot run remotely.
 *
 * claude/codex run through their ACP bridge packages via npx, pinned to the same
 * versions the local spawn uses. Any other backend must be a bare command name that
 * the remote resolves on its own PATH: an absolute path comes from THIS machine
 * (the bundled Fuigo engine, an installed agent) and does not exist over there.
 * @exported for testing
 */
export function remoteAgentArgv(backend: string, command?: string, args: string[] = []): string[] | undefined {
  if (backend === 'claude') return ['npx', '-y', CLAUDE_ACP_NPX_PACKAGE];
  if (backend === 'codex') return ['npx', '-y', CODEX_ACP_NPX_PACKAGE];
  if (!command || command.startsWith('/') || /\s/.test(command) || command.includes('..')) return undefined;
  return [command, ...args];
}

/**
 * Build the ssh invocation that runs `argv` on `host` with `cwd` as its working
 * directory, stdio forwarded so ACP's JSON-RPC rides the SSH channel.
 *
 * The remote command goes through `bash -lc` because a non-interactive ssh shell has
 * a minimal PATH (user-installed node/claude/codex only resolve in a login shell).
 * Every word is single-quoted, so a path or argument cannot add commands.
 * @exported for testing
 */
export function buildSshSpawn(host: SshHost, cwd: string, argv: string[]): SshSpawn {
  if (!cwd.startsWith('/') || cwd.includes('\0')) throw new Error('Remote workspace must be an absolute path');
  if (argv.length === 0 || argv.some((a) => a.includes('\0'))) throw new Error('Invalid remote command');
  const script = `cd ${shellQuote(cwd)} && exec ${argv.map(shellQuote).join(' ')}`;
  return {
    command: 'ssh',
    args: [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '--',
      host.alias,
      `bash -lc ${shellQuote(script)}`,
    ],
    // ssh needs to find itself, the user's keys and agent; nothing else of this
    // server's environment (provider keys, router settings) should ride along.
    env: pickEnv(process.env, ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'LANG']),
  };
}

function pickEnv(source: NodeJS.ProcessEnv, keys: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/** Resolve an alias against the server's own ssh config, then build the launch. */
export function buildRemoteAgentSpawn(
  alias: string,
  backend: string,
  cwd: string,
  command?: string,
  args?: string[]
): SshSpawn {
  const host = findSshHost(alias);
  if (!host) throw new Error(`Unknown SSH host "${alias}"`);
  const argv = remoteAgentArgv(backend, command, args);
  if (!argv) throw new Error(`The ${backend} agent cannot run on a remote host`);
  return buildSshSpawn(host, cwd, argv);
}
