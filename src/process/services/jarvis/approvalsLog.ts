/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The JARVIS approvals ledger - one JSON object per line, append-only.
 *
 * Two processes write and read it and they do not share a runtime: the tool
 * filter shim (a self-contained CJS bundle running from `app.asar.unpacked`)
 * APPENDS, and the main process READS for Mission Control and the HTTP route.
 * So this module is node-builtins only - the DATA_DIR resolution that needs
 * platform services lives in `approvalsPath.ts`, which the shim never imports.
 *
 * JSONL rather than a table: the writer is a short-lived child process with no
 * database handle, and an append of one line is the only write shape that stays
 * correct when several connectors' shims append concurrently.
 */

import fs from 'node:fs';
import path from 'node:path';

/** One recorded decision. `connector` is `''` when the tool name carried none. */
export type ApprovalRecord = {
  /** ms-epoch, matching the convention of the cost repositories. */
  ts: number;
  agent: string;
  rung: number;
  tool: string;
  connector: string;
  decision: 'refused' | 'allowed';
  reason: string;
};

/** Rows returned to the UI. Never more than this many, newest first. */
export const APPROVALS_PAGE_SIZE = 200;

/**
 * How much of the tail a read looks at: 256 KB, comfortably more than
 * `APPROVALS_PAGE_SIZE` rows of the record shape above.
 *
 * The UI polls this file, and the file only grows. Reading the WHOLE ledger to
 * hand back 200 rows meant every poll's cost tracked total history - a few MB
 * of JSON parsed per refresh on a long-lived install, to display the last page.
 * Seeking to the end and reading a bounded window costs the same on day 400 as
 * on day 1.
 */
export const APPROVALS_TAIL_BYTES = 256 * 1024;

/**
 * Rotate at 5 MB, keeping exactly ONE generation (`approvals.jsonl.1`).
 *
 * Unbounded is not an option for a file every tool call may append to, and a
 * multi-generation scheme would be a retention policy nobody asked for. One
 * rotation bounds the ledger at ~10 MB while keeping "yesterday" readable on
 * disk; the UI only ever reads the live file, so a rotation is invisible to it
 * beyond older rows falling off the end.
 */
export const APPROVALS_ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * Directories this process has already created. `mkdirSync` was being paid on
 * EVERY append - a syscall per recorded decision for a directory that is
 * created once per install. The shim is a long-lived child, so remembering is
 * enough; a `recursive: true` mkdir is idempotent, so a stale entry after
 * someone deletes the directory mid-session costs one lost line, not a crash.
 */
const ensuredDirs = new Set<string>();

/**
 * Rename the live ledger out of the way once it passes
 * {@link APPROVALS_ROTATE_BYTES}. Best effort, like everything else here.
 */
function rotateIfOversized(logPath: string): void {
  try {
    if (fs.statSync(logPath).size < APPROVALS_ROTATE_BYTES) return;
    // `rename` over an existing `.1` replaces it on both POSIX and Windows, so
    // the previous generation is dropped rather than accumulating.
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // No file yet, or a rename we lost a race for. Either way the append below
    // is still the right next move.
  }
}

/**
 * Append one decision.
 *
 * NEVER throws: a ledger write failing must not take down the tool call it was
 * describing, and the shim has no channel to report it on other than stderr.
 */
export function appendApprovalTo(logPath: string, record: ApprovalRecord): void {
  try {
    const dir = path.dirname(logPath);
    if (!ensuredDirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      ensuredDirs.add(dir);
    }
    rotateIfOversized(logPath);
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Best effort by design - see above.
  }
}

/**
 * Read at most the last {@link APPROVALS_TAIL_BYTES} of a file.
 *
 * The window may start mid-line. That torn FIRST line is dropped by the caller
 * the same way a torn last line is - it cannot be parsed, and inventing a
 * partial record would be worse than losing one row at the edge of a 256 KB
 * window.
 */
function readTail(logPath: string, maxBytes: number): string {
  const handle = fs.openSync(logPath, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, maxBytes);
    if (length === 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    const read = fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(handle);
  }
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.ts === 'number' &&
    typeof row.tool === 'string' &&
    (row.decision === 'refused' || row.decision === 'allowed')
  );
}

/**
 * Read the last `limit` rows, newest first.
 *
 * Only the last {@link APPROVALS_TAIL_BYTES} are examined - see that constant
 * for why the whole file is not read. A line that does not parse is skipped
 * rather than failing the read: the file is written by concurrent appenders, a
 * torn final line is a normal state rather than a corrupt ledger, and the first
 * line of the window is torn by construction.
 */
export function readApprovalsFrom(logPath: string, limit: number = APPROVALS_PAGE_SIZE): ApprovalRecord[] {
  let raw: string;
  try {
    raw = readTail(logPath, APPROVALS_TAIL_BYTES);
  } catch {
    // No ledger yet is the normal first-run state, not an error.
    return [];
  }
  const lines = raw.split('\n');
  const out: ApprovalRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isApprovalRecord(parsed)) out.push(parsed);
    } catch {
      // Skip, keep reading older lines.
    }
  }
  return out;
}
