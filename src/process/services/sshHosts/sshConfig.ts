/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** One concrete `Host` entry from an OpenSSH client config. */
export type SshHost = {
  /** First alias on the Host line; the name passed to `ssh`. */
  alias: string;
  /** Every concrete alias on the same Host line (includes `alias`). */
  aliases: string[];
  hostName?: string;
  user?: string;
  port?: number;
};

const WILDCARD = /[*?!]/;
// An alias is later handed to `ssh` as an argument, so it must not be able to
// look like an option or carry shell/whitespace characters.
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function splitWords(value: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) words.push(m[1] ?? m[2]);
  return words;
}

/**
 * Parse the concrete (non-wildcard) hosts out of an ssh_config body.
 *
 * Deliberately small: `Host` blocks with HostName/User/Port. `Match` blocks and
 * `Include` are not followed, and wildcard/negated patterns are skipped, so the
 * result is only hosts the user named explicitly. Git forges (User git) are
 * dropped since they are not shell targets. First definition of an alias wins,
 * which matches how ssh itself resolves duplicates.
 * @exported for testing
 */
export function parseSshConfig(text: string): SshHost[] {
  const hosts: SshHost[] = [];
  const seen = new Set<string>();
  let current: SshHost | null = null;
  let inMatch = false;

  const flush = () => {
    if (current && current.user !== 'git') hosts.push(current);
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (key === 'host') {
      flush();
      inMatch = false;
      const aliases = splitWords(value).filter((a) => !WILDCARD.test(a) && SAFE_ALIAS.test(a) && !seen.has(a));
      if (aliases.length === 0) continue;
      aliases.forEach((a) => seen.add(a));
      current = { alias: aliases[0], aliases };
      continue;
    }
    if (key === 'match') {
      flush();
      inMatch = true;
      continue;
    }
    if (!current || inMatch) continue;

    if (key === 'hostname' && current.hostName === undefined) current.hostName = splitWords(value)[0];
    else if (key === 'user' && current.user === undefined) current.user = splitWords(value)[0];
    else if (key === 'port' && current.port === undefined) {
      const port = Number(splitWords(value)[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) current.port = port;
    }
  }
  flush();
  return hosts;
}

export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config');
}

/** Read the user's ssh config; a missing or unreadable file means no hosts. */
export function loadSshHosts(configPath = defaultSshConfigPath()): SshHost[] {
  try {
    return parseSshConfig(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }
}

/** Resolve an alias against the configured hosts only; never trust a raw name. */
export function findSshHost(alias: string, hosts = loadSshHosts()): SshHost | undefined {
  return hosts.find((h) => h.aliases.includes(alias));
}
