/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 * Modified by Ferrox Labs in 2026. Changes are documented in the project history.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appDataDir } from '@process/utils/appPaths';
import { writeFileSyncAtomic } from './atomicWrite';

const FILE_NAME = 'analytics.json';

type AnalyticsData = { id: string };

/**
 * Returns a persistent anonymous analytics ID for this installation.
 * Stored in <userData>/analytics.json (DATA_DIR in the standalone server).
 * No personal data is collected - the ID is a random UUID.
 */
export function getOrCreateAnalyticsId(): string {
  const filePath = path.join(appDataDir(), FILE_NAME);
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AnalyticsData;
      if (typeof data?.id === 'string' && data.id.length > 0) {
        return data.id;
      }
    }
  } catch {
    // fall through to generate a new one
  }

  const id = crypto.randomUUID();
  try {
    writeFileSyncAtomic(filePath, JSON.stringify({ id }), { mode: 0o600 });
  } catch {
    // best-effort - if write fails, the ID won't persist but won't throw either
  }
  return id;
}
