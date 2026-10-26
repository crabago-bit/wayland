/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A workspace on an SSH host, carried through the folder-picker and composer as one
 * string: `ssh://<alias>/<absolute path>`. The alias must name a host in the
 * server's ssh config; the server re-checks it, so this only transports the pair.
 */
export type SshWorkspace = { host: string; path: string };

const SSH_WORKSPACE = /^ssh:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/.*)$/;

export function formatSshWorkspace(host: string, path: string): string {
  return `ssh://${host}${path}`;
}

export function parseSshWorkspace(value: string | undefined | null): SshWorkspace | null {
  const m = value ? SSH_WORKSPACE.exec(value) : null;
  return m ? { host: m[1], path: m[2] } : null;
}

/** Marker in `dialog.showOpen` properties: the caller can use a remote folder. */
export const ALLOW_REMOTE_PROPERTY = 'allowRemote';
