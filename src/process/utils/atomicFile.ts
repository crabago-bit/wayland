/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Atomic file write: temp file + fdatasync + rename, so a reader never sees a half-written
 * file and a crash never leaves one behind. Used by the agent connectors and the connector
 * manifest.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export async function writeAtomic(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}`);
  const handle = await fs.promises.open(tmp, 'w', 0o600);
  let closed = false;
  try {
    await handle.writeFile(content, 'utf-8');
    // GEM-R-04: fdatasync before rename for durability.
    await handle.sync();
  } catch (err) {
    // Ensure we don't leak the temp file on write/sync failure.
    try {
      await handle.close();
      closed = true;
    } catch {
      /* ignore close error */
    }
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    if (!closed) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }
  await fs.promises.rename(tmp, target);
}
