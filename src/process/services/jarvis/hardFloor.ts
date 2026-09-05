/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The operator's hard floor, read from `~/.claude/crew-state/autonomy.md`.
 *
 * ADDITIVE ONLY. `DEFAULT_HARD_FLOOR_PATTERN` ships in code and always applies;
 * this file can only widen it. A renamed, deleted or unparseable notes file
 * therefore weakens nothing - the failure mode of "the operator moved their
 * notes" must never be "payroll tools became callable".
 *
 * Read once and cached: it is consulted on every session spawn and the UI
 * displays it, and re-reading the operator's home directory on each MCP
 * descriptor build would be a per-connector stat for a file that changes about
 * as often as the blueprint does. `refreshHardFloor()` exists for the settings
 * page to force a re-read.
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

/** Extra hard-floor keywords from the operator's notes. `[]` when absent. */
export function readHardFloorKeywords(): string[] {
  if (cached) return cached;
  try {
    cached = parseHardFloorKeywords(fs.readFileSync(autonomyNotesPath(), 'utf8'));
  } catch {
    cached = [];
  }
  return cached;
}

/** Drop the cache so the next read picks up an edited notes file. */
export function refreshHardFloor(): void {
  cached = null;
}
