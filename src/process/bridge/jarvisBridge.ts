/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JARVIS autonomy bridge - the read-only view of the approvals ledger and the
 * hard floor for the local renderer (Mission Control's Approvals section and
 * the Agents settings page).
 *
 * Mirrors costBridge: one-shot providers, each swallowing its own errors and
 * returning an empty result, so a missing ledger file (the normal first-run
 * state) never breaks the page that asks for it.
 *
 * There is deliberately no write provider. The ledger is appended by the tool
 * filter shim as a side effect of enforcement; anything that could edit it from
 * the renderer would make it a record of what someone was willing to admit
 * rather than a record of what happened.
 */

import { ipcBridge } from '@/common';
import { DEFAULT_HARD_FLOOR_TOKENS, type HardFloorInfo } from '@/common/jarvis/autonomy';
import { APPROVALS_PAGE_SIZE, readApprovalsFrom, type ApprovalRecord } from '@process/services/jarvis/approvalsLog';
import { resolveApprovalsLogPath } from '@process/services/jarvis/approvalsPath';
import { hardFloorNotesFound, refreshHardFloor } from '@process/services/jarvis/hardFloor';

/** Shared reader so the IPC provider and the HTTP route cannot diverge. */
export function listApprovals(limit?: number): ApprovalRecord[] {
  const capped = Math.min(Math.max(1, Math.floor(limit ?? APPROVALS_PAGE_SIZE)), APPROVALS_PAGE_SIZE);
  return readApprovalsFrom(resolveApprovalsLogPath(), capped);
}

/**
 * The effective hard floor, for display. Never a promise the shim doesn't keep.
 *
 * Forces a re-read of the operator's notes first, so opening the settings card
 * (or refreshing the Approvals view) shows what the file says NOW rather than
 * what it said at the first session spawn of this app run.
 *
 * Returns `notesFileFound`, NOT the notes path: the identical payload is served
 * to remote WebUI callers by `GET /api/jarvis/approvals`, and an absolute path
 * under `$HOME` discloses the desktop user's account name to a paired browser
 * for no benefit the boolean does not already give.
 */
export function describeHardFloor(): HardFloorInfo {
  const keywords = refreshHardFloor();
  return {
    builtinTokens: [...DEFAULT_HARD_FLOOR_TOKENS],
    keywords,
    notesFileFound: hardFloorNotesFound(),
  };
}

export function initJarvisBridge(): void {
  ipcBridge.jarvis.approvals.provider(async (input: { limit?: number }): Promise<ApprovalRecord[]> => {
    try {
      return listApprovals(input?.limit);
    } catch (error) {
      console.error('[jarvisBridge] approvals error:', error);
      return [];
    }
  });

  ipcBridge.jarvis.hardFloor.provider(async () => {
    try {
      return describeHardFloor();
    } catch (error) {
      console.error('[jarvisBridge] hardFloor error:', error);
      return { builtinTokens: [...DEFAULT_HARD_FLOOR_TOKENS], keywords: [], notesFileFound: false };
    }
  });
}
