/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * IJFW atomic-file helpers - write-temp + fdatasync + rename, EXDEV-aware
 * cross-device move. Fixes GEM-R-01 (cross-device fallback) and GEM-R-04
 * (fdatasync before rename for durability).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * LOCAL PATCH (not upstream): `app` is resolved lazily instead of via a
 * top-level `import { app } from 'electron'`.
 *
 * `writeAtomic` is the write primitive for the Flux connectors and their
 * manifest, and those now run in the non-Electron WebUI server too. A top-level
 * electron import is fatal there: node_modules/electron/index.js executes
 * `module.exports = getElectronPath()` on evaluation and THROWS
 * "Electron failed to install correctly" outside an Electron runtime — which
 * would take down every module that transitively imports this one, even though
 * `app` is only ever touched by ijfwCacheKey().
 *
 * Deferring the require keeps Electron out of the import graph for the
 * filesystem helpers while leaving ijfwCacheKey()'s behaviour unchanged on
 * desktop.
 */
function electronApp(): { getVersion(): string } | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('electron') as { app?: { getVersion(): string } }).app;
  } catch {
    return undefined;
  }
}

const COPYFILE_EXCL = (fs.constants as { COPYFILE_EXCL?: number }).COPYFILE_EXCL ?? 1;

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

export async function moveWithExdevFallback(src: string, dst: string): Promise<void> {
  try {
    await fs.promises.rename(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    // GEM-R-01: cross-device fallback.
    await copyRecursive(src, dst);
    await fs.promises.rm(src, { recursive: true, force: true });
  }
}

async function copyRecursive(src: string, dst: string): Promise<void> {
  const stat = await fs.promises.lstat(src);
  if (stat.isDirectory()) {
    await fs.promises.mkdir(dst, { recursive: true, mode: stat.mode });
    const entries = await fs.promises.readdir(src);
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else if (stat.isSymbolicLink()) {
    const linkTarget = await fs.promises.readlink(src);
    await fs.promises.symlink(linkTarget, dst);
  } else {
    await fs.promises.copyFile(src, dst, COPYFILE_EXCL);
  }
}

export function ijfwCacheKey(): string {
  const parts = [
    electronApp()?.getVersion() ?? 'app-unknown',
    process.versions.electron ?? 'electron-unknown',
    process.versions.node ?? 'node-unknown',
    'ijfw-install-v1',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}
