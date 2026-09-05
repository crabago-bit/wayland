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
import { DEFAULT_HARD_FLOOR_PATTERN } from '@/common/jarvis/autonomy';
import { APPROVALS_PAGE_SIZE, readApprovalsFrom, type ApprovalRecord } from '@process/services/jarvis/approvalsLog';
import { resolveApprovalsLogPath } from '@process/services/jarvis/approvalsPath';
import { autonomyNotesPath, readHardFloorKeywords } from '@process/services/jarvis/hardFloor';

/** Shared reader so the IPC provider and the HTTP route cannot diverge. */
export function listApprovals(limit?: number): ApprovalRecord[] {
  const capped = Math.min(Math.max(1, Math.floor(limit ?? APPROVALS_PAGE_SIZE)), APPROVALS_PAGE_SIZE);
  return readApprovalsFrom(resolveApprovalsLogPath(), capped);
}

/** The effective hard floor, for display. Never a promise the shim doesn't keep. */
export function describeHardFloor(): { pattern: string; keywords: string[]; notesPath: string } {
  return {
    pattern: DEFAULT_HARD_FLOOR_PATTERN.source,
    keywords: readHardFloorKeywords(),
    notesPath: autonomyNotesPath(),
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
      return { pattern: DEFAULT_HARD_FLOOR_PATTERN.source, keywords: [], notesPath: '' };
    }
  });
}
