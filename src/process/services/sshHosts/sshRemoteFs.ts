/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'child_process';
import { parseSshWorkspace, formatSshWorkspace } from '@/common/utils/sshWorkspace';
import { findSshHost, type SshHost } from './sshConfig';
import { shellQuote, sshArgs } from './sshRemoteBrowse';

/**
 * File access on SSH hosts for the workspace panel and previews.
 *
 * Paths cross the UI as `ssh://<alias>/<absolute path>`. Every operation resolves the
 * alias against the server's own ssh config and runs a fixed script on the host with
 * the path passed as a quoted argument, so a path can never add commands. Access is
 * whatever the SSH user has on that machine; there is no folder confinement as there
 * is for this server's own disk, because the whole point is working on those hosts.
 */

export type RemoteRef = { host: SshHost; path: string };

/** Resolve an `ssh://alias/path` string to a configured host, or null. */
export function resolveRemoteRef(value: string | undefined | null): RemoteRef | null {
  const parsed = parseSshWorkspace(value);
  if (!parsed || parsed.path.includes('\0')) return null;
  const host = findSshHost(parsed.host);
  return host ? { host, path: parsed.path } : null;
}

/** True when the string names a remote workspace, even if its host is unknown. */
export function isRemotePath(value: string | undefined | null): boolean {
  return parseSshWorkspace(value) !== null;
}

type RunOptions = { input?: Buffer | string; maxBuffer?: number; timeoutMs?: number };

function runRemote(host: SshHost, script: string, args: string[], opts: RunOptions = {}): Promise<Buffer> {
  const command = `sh -c ${shellQuote(script)} sh ${args.map(shellQuote).join(' ')}`;
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      sshArgs(host, command),
      {
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        encoding: 'buffer',
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString('utf8').trim().split('\n').pop();
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          reject(Object.assign(new Error(detail || error.message), { code }));
          return;
        }
        resolve(stdout);
      }
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_BINARY_BYTES = 32 * 1024 * 1024;

const READ_SCRIPT = [
  '[ -f "$1" ] || exit 4',
  'size=$(wc -c < "$1" | tr -d " ")',
  '[ "$size" -le "$2" ] || exit 5',
  'cat -- "$1"',
].join('\n');

/** Read a remote file; null when it is missing, not a file, or over the size cap. */
export async function remoteReadFile(ref: RemoteRef, maxBytes = MAX_TEXT_BYTES): Promise<Buffer | null> {
  try {
    return await runRemote(ref.host, READ_SCRIPT, [ref.path, String(maxBytes)], { maxBuffer: maxBytes + 1024 });
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 4 || code === 5) return null;
    throw error;
  }
}

export const remoteReadBinary = (ref: RemoteRef) => remoteReadFile(ref, MAX_BINARY_BYTES);

/** Overwrite a remote file in place (keeps its mode and owner). */
export async function remoteWriteFile(ref: RemoteRef, data: Uint8Array | string): Promise<void> {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  if (body.length > MAX_TEXT_BYTES * 2) throw new Error('File too large to write');
  await runRemote(ref.host, 'cat > "$1"', [ref.path], { input: body });
}

export type RemoteStat = { size: number; lastModified: number; isDirectory: boolean } | null;

const STAT_SCRIPT = [
  '[ -e "$1" ] || exit 4',
  'if [ -d "$1" ]; then d=d; else d=f; fi',
  'size=$(wc -c < "$1" 2>/dev/null | tr -d " ")',
  'mtime=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)',
  'printf "%s %s %s" "$d" "${size:-0}" "${mtime:-0}"',
].join('\n');

export async function remoteStat(ref: RemoteRef): Promise<RemoteStat> {
  try {
    const [kind, size, mtime] = (await runRemote(ref.host, STAT_SCRIPT, [ref.path])).toString('utf8').split(' ');
    return { size: Number(size) || 0, lastModified: (Number(mtime) || 0) * 1000, isDirectory: kind === 'd' };
  } catch (error) {
    if ((error as { code?: number | string }).code === 4) return null;
    throw error;
  }
}

export type RemoteEntry = { name: string; fullPath: string; relativePath: string; isDir: boolean; isFile: boolean };
export type RemoteTreeNode = RemoteEntry & { children?: RemoteTreeNode[] };

const IGNORED_DIRS = ['.git', 'node_modules', '__pycache__', '.cache', '.next', '.venv', 'venv'];
const MAX_ENTRIES = 4000;

// Prune heavy directories, then print "<d|f> NUL path NUL" for everything left.
// `find` and `sh` only: runs unchanged on GNU/Linux and macOS.
const TREE_SCRIPT = [
  'cd -- "$1" 2>/dev/null || exit 3',
  'depth=$2; shift 2',
  'find . -mindepth 1 -maxdepth "$depth" \\( ' +
    IGNORED_DIRS.map((d) => `-name ${shellQuote(d)}`).join(' -o ') +
    ' \\) -prune -o -exec sh -c \'for f; do if [ -d "$f" ]; then printf "d\\0%s\\0" "$f"; else printf "f\\0%s\\0" "$f"; fi; done\' sh {} +',
].join('\n');

/** Flat listing below `root` (relative paths), directories and files, capped. */
export async function remoteList(
  ref: RemoteRef,
  maxDepth: number
): Promise<{ entries: RemoteEntry[]; truncated: boolean }> {
  const out = (await runRemote(ref.host, TREE_SCRIPT, [ref.path, String(maxDepth)], { timeoutMs: 45_000 })).toString(
    'utf8'
  );
  const fields = out.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const base = ref.path === '/' ? '' : ref.path.replace(/\/+$/, '');
  const entries: RemoteEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const relativePath = fields[i + 1].replace(/^\.\//, '');
    if (!relativePath) continue;
    const isDir = fields[i] === 'd';
    entries.push({
      name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
      fullPath: formatSshWorkspace(ref.host.alias, `${base}/${relativePath}`),
      relativePath,
      isDir,
      isFile: !isDir,
    });
  }
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const truncated = entries.length > MAX_ENTRIES;
  return { entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated };
}

/** Nest a flat listing into the tree shape the workspace panel renders. */
export function buildRemoteTree(ref: RemoteRef, entries: RemoteEntry[]): RemoteTreeNode {
  const rootName = ref.path.replace(/\/+$/, '').split('/').pop() || '/';
  const root: RemoteTreeNode = {
    name: rootName,
    fullPath: formatSshWorkspace(ref.host.alias, ref.path),
    relativePath: '',
    isDir: true,
    isFile: false,
    children: [],
  };
  const dirs = new Map<string, RemoteTreeNode>([['', root]]);
  for (const entry of entries) {
    const node: RemoteTreeNode = { ...entry, children: entry.isDir ? [] : undefined };
    const slash = entry.relativePath.lastIndexOf('/');
    const parent = dirs.get(slash === -1 ? '' : entry.relativePath.slice(0, slash)) ?? root;
    parent.children?.push(node);
    if (entry.isDir) dirs.set(entry.relativePath, node);
  }
  const order = (nodes: RemoteTreeNode[] | undefined) => {
    nodes?.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    nodes?.forEach((n) => order(n.children));
  };
  order(root.children);
  return root;
}
