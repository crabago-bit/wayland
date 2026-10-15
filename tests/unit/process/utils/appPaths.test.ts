/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The bun WebUI server resolves `electron` to the npm package, whose `app` is
 * undefined, so every bare `app.getPath(...)` threw there (the Fuigo terminal,
 * the storage routes, the activity log, sync state, the analytics id, the
 * TVControl runtime, the models.dev cache). The appPaths helpers keep Electron's
 * answer when `app` exists and fall back to the platform services otherwise.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeApp = {
  getPath: (name: string) => string;
  getAppPath: () => string;
  isPackaged: boolean;
};
const electronState = vi.hoisted(() => ({ app: undefined as FakeApp | undefined }));
vi.mock('electron', () => ({
  get app() {
    return electronState.app;
  },
}));

import { appBundlePath, appDataDir, appIsPackaged, appLogsDir, appUserDir } from '@process/utils/appPaths';
import { resolveTerminalCommand } from '@process/terminal/terminalCommand';
import { getLogsDir, getUserDataDir } from '@process/storage/storageLocations';
import { bundledTvControlRoot } from '@process/services/mcpServices/bundledTvControl';
import { getOrCreateAnalyticsId } from '@process/utils/analyticsId';
import { appendActivity, getActivity } from '@process/webui/activityLog';

const ELECTRON_APP: FakeApp = {
  getPath: (name) => `/electron/${name}`,
  getAppPath: () => '/electron/app',
  isPackaged: true,
};

const ENV_KEYS = ['DATA_DIR', 'LOGS_DIR', 'IS_PACKAGED'] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let tmp: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-paths-'));
  electronState.app = undefined;
  process.env.DATA_DIR = path.join(tmp, 'data');
  process.env.LOGS_DIR = path.join(tmp, 'logs');
  delete process.env.IS_PACKAGED;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  electronState.app = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('appPaths in the standalone server (no Electron app)', () => {
  it('resolves every path kind from the platform services', () => {
    expect(appDataDir()).toBe(path.join(tmp, 'data'));
    expect(appLogsDir()).toBe(path.join(tmp, 'logs'));
    expect(appBundlePath()).toBe(process.cwd());
    expect(appIsPackaged()).toBe(false);
    process.env.IS_PACKAGED = 'true';
    expect(appIsPackaged()).toBe(true);
    expect(appUserDir('documents')).toBe(path.join(os.homedir(), 'Documents'));
    expect(appUserDir('downloads')).toBe(path.join(os.homedir(), 'Downloads'));
  });

  it.each([
    ['empty', ''],
    ['relative', 'data'],
  ])('refuses an %s DATA_DIR', (_label, value) => {
    process.env.DATA_DIR = value;
    expect(() => appDataDir()).toThrow(/data directory must be an absolute path/);
  });

  it('opens the Fuigo terminal on the engine home under DATA_DIR', () => {
    const spec = resolveTerminalCommand(
      { type: 'acp', extra: { backend: 'fuigo', workspace: '/proj' } },
      { resolveFuigo: () => ({ path: '/bundled/fuigo' }) }
    );
    expect(spec?.env).toEqual({ FUIGO_HOME: path.join(tmp, 'data', 'fuigo') });
  });

  it('serves the storage dirs, TVControl root, analytics id and activity log from the server data dir', () => {
    expect(getUserDataDir()).toBe(path.join(tmp, 'data'));
    expect(getLogsDir()).toBe(path.join(tmp, 'logs'));
    expect(bundledTvControlRoot()).toBe(path.join(process.cwd(), 'resources', 'bundled-tvcontrol'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    const id = getOrCreateAnalyticsId();
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'analytics.json'), 'utf8'))).toEqual({ id });
    appendActivity('login', 'from test');
    expect(getActivity().map((e) => e.detail)).toContain('from test');
    expect(fs.existsSync(path.join(tmp, 'data', 'webui-activity.json'))).toBe(true);
  });
});

describe('appPaths under Electron (behaviour unchanged)', () => {
  it('uses Electron app paths when the app exists', () => {
    electronState.app = ELECTRON_APP;
    expect(appDataDir()).toBe('/electron/userData');
    expect(appLogsDir()).toBe('/electron/logs');
    expect(appBundlePath()).toBe('/electron/app');
    expect(appIsPackaged()).toBe(true);
    expect(appUserDir('documents')).toBe('/electron/documents');
    expect(getUserDataDir()).toBe('/electron/userData');
    const spec = resolveTerminalCommand(
      { type: 'acp', extra: { backend: 'fuigo', workspace: '/proj' } },
      { resolveFuigo: () => ({ path: '/bundled/fuigo' }) }
    );
    expect(spec?.env).toEqual({ FUIGO_HOME: path.join('/electron/userData', 'fuigo') });
  });

  it('falls back to <userData>/logs when Electron has no logs path', () => {
    electronState.app = {
      ...ELECTRON_APP,
      getPath: (name) => {
        if (name === 'logs') throw new Error('no logs path');
        return `/electron/${name}`;
      },
    };
    expect(appLogsDir()).toBe(path.join('/electron/userData', 'logs'));
  });
});
