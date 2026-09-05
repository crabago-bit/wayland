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
 * Append one decision.
 *
 * NEVER throws: a ledger write failing must not take down the tool call it was
 * describing, and the shim has no channel to report it on other than stderr.
 */
export function appendApprovalTo(logPath: string, record: ApprovalRecord): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Best effort by design - see above.
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
 * A line that does not parse is skipped rather than failing the read: the file
 * is written by concurrent appenders and a torn final line is a normal state,
 * not a corrupt ledger.
 */
export function readApprovalsFrom(logPath: string, limit: number = APPROVALS_PAGE_SIZE): ApprovalRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
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
