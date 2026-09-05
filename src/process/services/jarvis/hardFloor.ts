/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The operator's hard floor, read from `~/.claude/crew-state/autonomy.md`.
 *
 * ADDITIVE ONLY. `DEFAULT_HARD_FLOOR_TOKENS` ships in code and always applies;
 * this file can only widen it. A renamed, deleted or unparseable notes file
 * therefore weakens nothing - the failure mode of "the operator moved their
 * notes" must never be "payroll tools became callable".
 *
 * Read once and CACHED, because it is consulted on every session spawn and
 * re-reading the operator's home directory per MCP descriptor would be a stat
 * for a file that changes about as often as the blueprint does. The cache is
 * dropped by {@link refreshHardFloor}, which `describeHardFloor()` calls: the
 * settings card and the Approvals view are the surfaces that display the floor,
 * so opening either is exactly the moment an edited file should take effect.
 * Sessions already running keep the snapshot they were spawned with, by design -
 * a connector's enforcement must not change under it mid-call.
 *
 * The FORMAT the file must use is declared in `@/common/jarvis/autonomy`: a
 * `hard-floor-tokens: a, b, c` line, or a fenced `hard-floor` block. Prose is
 * ignored on purpose - see that module's header for why.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHardFloorKeywords } from '@/common/jarvis/autonomy';

/** The blueprint's own copy of the ladder, outside the app's storage. */
export function autonomyNotesPath(): string {
  return path.join(os.homedir(), '.claude', 'crew-state', 'autonomy.md');
}

let cached: string[] | null = null;
let notesFound = false;

/** Extra hard-floor keywords from the operator's notes. `[]` when absent. */
export function readHardFloorKeywords(): string[] {
  if (cached) return cached;
  try {
    cached = parseHardFloorKeywords(fs.readFileSync(autonomyNotesPath(), 'utf8'));
    notesFound = true;
  } catch {
    cached = [];
    notesFound = false;
  }
  return cached;
}

/**
 * Drop the cache, re-read the notes file, and return what it now declares.
 *
 * Returning the fresh list (rather than void) is what makes this callable
 * straight from `describeHardFloor()` without a second read that could observe
 * a different file.
 */
export function refreshHardFloor(): string[] {
  cached = null;
  return readHardFloorKeywords();
}

/**
 * Whether the notes file was readable at the last read. Displayed as a boolean
 * so no surface has to hand out a path under the operator's home directory.
 */
export function hardFloorNotesFound(): boolean {
  if (!cached) readHardFloorKeywords();
  return notesFound;
}
