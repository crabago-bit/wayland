/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where the approvals ledger lives: `$DATA_DIR/jarvis/approvals.jsonl`.
 *
 * Split out of `approvalsLog.ts` on purpose. This file reaches for platform
 * services (Electron `userData` on desktop, the configured data root headless);
 * the tool filter shim is a standalone child process that has neither, so the
 * host resolves the path once and hands it to the shim on argv.
 */

import path from 'node:path';
import { getPlatformServices } from '@/common/platform';

export function resolveApprovalsLogPath(): string {
  return path.join(getPlatformServices().paths.getDataDir(), 'jarvis', 'approvals.jsonl');
}
