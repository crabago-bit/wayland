/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where the Grok Build CLI may reach through the ACP client's `fs/*` methods
 * outside the chat workspace.
 *
 * Grok keeps cross-session memory as Markdown under `$GROK_HOME/memory-v2/`
 * (global and per-workspace `topics/` + `observations/`; default home
 * `~/.grok`). The model reads those files with its read tool and edits them
 * with its edit/write tools ("remember", "forget"), and with the client's fs
 * capability advertised those go through `fs/read_text_file` /
 * `fs/write_text_file` - which the workspace confinement refused, so Grok lost
 * its memory (seen live on 1.0.52: reads of
 * `memory-v2/workspaces/<slug>/topics/*.md`). memory-v2 is therefore both
 * readable and writable; nothing else under the Grok home is: the only `.grok`
 * path observed through ACP fs is memory-v2.
 *
 * The CLI's credentials (`auth.json` and its dot-suffixed backups and locks,
 * the `auth/` dir, a `GROK_AUTH_PATH` override) are DENIED outright, for reads
 * too, even when the workspace itself contains them (a chat opened on the home
 * directory). See AgentConfig.deniedPaths for how a denial matches.
 */

import os from 'node:os';
import path from 'node:path';

type Env = Record<string, string | undefined> | undefined;

/** `$GROK_HOME` from the spawn env, then this process's env, when absolute; else `~/.grok`. */
export function grokHomeDir(env?: Env): string {
  const configured = env?.GROK_HOME ?? process.env.GROK_HOME;
  return configured && path.isAbsolute(configured) ? path.resolve(configured) : path.join(os.homedir(), '.grok');
}

/** The ACP fs roots and denials for one Grok session. */
export function grokFsRoots(env?: Env): { readOnlyRoots: string[]; writableRoots: string[]; deniedPaths: string[] } {
  const home = grokHomeDir(env);
  const memory = path.join(home, 'memory-v2');
  const authOverride = env?.GROK_AUTH_PATH ?? process.env.GROK_AUTH_PATH;
  return {
    readOnlyRoots: [memory],
    writableRoots: [memory],
    deniedPaths: [
      path.join(home, 'auth.json'),
      path.join(home, 'auth'),
      ...(authOverride && path.isAbsolute(authOverride) ? [path.resolve(authOverride)] : []),
    ],
  };
}
