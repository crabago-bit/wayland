/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'child_process';
import type { SshHost } from './sshConfig';

export type RemoteDirectoryItem = {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
};

export type RemoteDirectoryListing = {
  currentPath: string;
  parentPath: string | undefined;
  items: RemoteDirectoryItem[];
  canGoUp: boolean;
  truncated: boolean;
};

const MAX_ITEMS = 500;
const SSH_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** Quote one argument for a POSIX shell (single quotes, embedded ' escaped). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Read-only remote listing script. `$1` is the requested path ("" or "~" is
 * the home dir, "~/x" is relative to home). Output is NUL-delimited: the
 * canonical directory, then (type, name) pairs for visible entries.
 * Portable across GNU/Linux and macOS: no `find -printf`, no `ls` parsing.
 */
const LIST_SCRIPT = [
  'case "$1" in ""|"~") p=$HOME;; "~/"*) p=$HOME/${1#"~/"};; *) p=$1;; esac',
  'cd -- "$p" 2>/dev/null || { echo "cannot open directory" >&2; exit 3; }',
  'printf "%s\\0" "$(pwd -P)"',
  'for f in *; do',
  '[ -e "$f" ] || continue',
  'if [ -d "$f" ]; then printf "d\\0%s\\0" "$f"; else printf "f\\0%s\\0" "$f"; fi',
  'done',
].join('\n');

export function buildRemoteListCommand(requestedPath: string): string {
  return `sh -c ${shellQuote(LIST_SCRIPT)} sh ${shellQuote(requestedPath)}`;
}

export function sshArgs(host: SshHost, remoteCommand: string): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=2',
    '--',
    host.alias,
    remoteCommand,
  ];
}

function posixDirname(p: string): string {
  if (p === '/') return '/';
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

/** Turn the script's NUL-delimited output into a listing. @exported for testing */
export function parseRemoteListing(stdout: string, showFiles: boolean): RemoteDirectoryListing {
  const fields = stdout.split('\0');
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  const currentPath = fields.shift() ?? '';
  if (!currentPath.startsWith('/')) throw new Error('Remote returned an unexpected listing');

  const base = currentPath === '/' ? '' : currentPath;
  const items: RemoteDirectoryItem[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const isDirectory = fields[i] === 'd';
    const name = fields[i + 1];
    if (!name || name.startsWith('.')) continue;
    if (!showFiles && !isDirectory) continue;
    items.push({ name, path: `${base}/${name}`, isDirectory, isFile: !isDirectory });
  }
  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const truncated = items.length > MAX_ITEMS;
  const parentPath = posixDirname(currentPath);
  return {
    currentPath,
    parentPath,
    items: truncated ? items.slice(0, MAX_ITEMS) : items,
    canGoUp: currentPath !== '/',
    truncated,
  };
}

/** List a directory on a configured SSH host. Read-only; nothing is written remotely. */
export function browseRemoteDirectory(
  host: SshHost,
  requestedPath: string,
  showFiles: boolean
): Promise<RemoteDirectoryListing> {
  if (requestedPath.includes('\0')) return Promise.reject(new Error('Invalid path'));
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      sshArgs(host, buildRemoteListCommand(requestedPath)),
      { timeout: SSH_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || '').trim().split('\n').pop() || error.message;
          reject(new Error(detail));
          return;
        }
        try {
          resolve(parseRemoteListing(stdout, showFiles));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}
