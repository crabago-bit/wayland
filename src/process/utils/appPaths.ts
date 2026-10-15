/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Electron `app` paths with a standalone fallback.
 *
 * The bun WebUI server resolves `electron` to the npm package, whose `app` is
 * undefined, so a bare `app.getPath(...)` throws there. Each helper uses
 * Electron's `app` when it exists (desktop behaviour unchanged) and otherwise
 * the platform services (`NodePlatformServices` in the server: DATA_DIR,
 * LOGS_DIR, the working directory) or the Node equivalent.
 */

import { getPlatformServices } from '@/common/platform';
import { app } from 'electron';
import path from 'node:path';

/**
 * Wayland's persistent data root: Electron `userData`, else the platform data
 * dir (DATA_DIR in the server). An empty or relative root is refused: every
 * path joined under it would resolve against the process cwd.
 */
export function appDataDir(): string {
  const dir = app?.getPath ? app.getPath('userData') : getPlatformServices().paths.getDataDir();
  if (!dir || !path.isAbsolute(dir)) {
    throw new Error(
      `Wayland data directory must be an absolute path, got ${JSON.stringify(dir ?? '')}; ` +
        'set DATA_DIR to an absolute path.'
    );
  }
  return path.resolve(dir);
}

/** Electron's `logs` dir (or `<userData>/logs`), else the platform logs dir (LOGS_DIR in the server). */
export function appLogsDir(): string {
  if (!app?.getPath) return getPlatformServices().paths.getLogsDir();
  try {
    return app.getPath('logs');
  } catch {
    return path.join(app.getPath('userData'), 'logs');
  }
}

/** Electron's app root, else the platform app path (the server's working directory). */
export function appBundlePath(): string {
  if (app?.getAppPath) return app.getAppPath();
  return getPlatformServices().paths.getAppPath() ?? process.cwd();
}

/** Electron's `isPackaged`, else the platform flag (IS_PACKAGED in the server). */
export function appIsPackaged(): boolean {
  if (app) return app.isPackaged === true;
  return getPlatformServices().paths.isPackaged();
}

/** Electron's documents/downloads dir, else `<home>/Documents` / `<home>/Downloads`. */
export function appUserDir(name: 'documents' | 'downloads'): string {
  if (app?.getPath) return app.getPath(name);
  return path.join(getPlatformServices().paths.getHomeDir(), name === 'documents' ? 'Documents' : 'Downloads');
}
