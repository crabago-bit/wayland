/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readFile, execFile, connect, saveXaiTokens, writeXaiEngineAuthFile, fetchSpy } = vi.hoisted(() => ({
  readFile: vi.fn(),
  execFile: vi.fn(),
  connect: vi.fn(),
  saveXaiTokens: vi.fn(),
  writeXaiEngineAuthFile: vi.fn(),
  fetchSpy: vi.fn(),
}));

vi.mock('node:fs', () => ({ promises: { readFile: (...a: unknown[]) => readFile(...a) } }));
vi.mock('node:child_process', () => ({ execFile: (...a: unknown[]) => execFile(...a) }));
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('electron-log', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@process/providers/ipc/modelRegistryIpc', () => ({
  connectModelRegistryProvider: (...a: unknown[]) => connect(...a),
}));
vi.mock('@process/onboarding/xaiTokenStore', () => ({
  loadXaiTokens: vi.fn(),
  saveXaiTokens: (...a: unknown[]) => saveXaiTokens(...a),
}));
vi.mock('@process/onboarding/xaiEngineAuthFile', () => ({
  readXaiEngineAuthFile: vi.fn(),
  writeXaiEngineAuthFile: (...a: unknown[]) => writeXaiEngineAuthFile(...a),
}));

import { xaiReuseCliLogin } from '@process/onboarding/xaiOAuth';

const HOUR = 60 * 60 * 1000;
const cliFile = (expiresAt: number) =>
  JSON.stringify({ access_token: 'access-1', refresh_token: 'cli-refresh', expires_at: expiresAt });

describe('xaiReuseCliLogin (Grok CLI owns its refresh token)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue({ ok: true });
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: () => void) => {
      cb();
      return { stdin: { end: vi.fn() } };
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('registers a valid CLI access token without persisting or sharing the refresh token', async () => {
    readFile.mockResolvedValue(cliFile(Date.now() + HOUR));

    await expect(xaiReuseCliLogin()).resolves.toEqual({ ok: true, reused: true });

    expect(connect).toHaveBeenCalledWith('xai', { key: 'access-1' });
    expect(saveXaiTokens).not.toHaveBeenCalled();
    expect(writeXaiEngineAuthFile).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('asks the CLI to refresh itself when expired and uses the rewritten file', async () => {
    readFile.mockResolvedValueOnce(cliFile(Date.now() - HOUR)).mockResolvedValueOnce(cliFile(Date.now() + HOUR));

    await expect(xaiReuseCliLogin()).resolves.toEqual({ ok: true, reused: true });

    expect(execFile).toHaveBeenCalledWith('grok', ['models'], expect.any(Object), expect.any(Function));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saveXaiTokens).not.toHaveBeenCalled();
  });

  it('never spends the CLI refresh token itself when the CLI could not refresh', async () => {
    readFile.mockResolvedValue(cliFile(Date.now() - HOUR));

    await expect(xaiReuseCliLogin()).resolves.toBeNull();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns null when there is no CLI login', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(xaiReuseCliLogin()).resolves.toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });
});
