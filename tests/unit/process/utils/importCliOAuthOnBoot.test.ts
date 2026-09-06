/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@process/onboarding/chatgptOAuth', () => ({ chatgptReuseCliLogin: vi.fn() }));
vi.mock('@process/onboarding/xaiOAuth', () => ({ xaiReuseCliLogin: vi.fn() }));
vi.mock('@process/providers/ipc/modelRegistryIpc', () => ({ getModelRegistryRepository: () => null }));

import {
  importCliOAuthOnBoot,
  refreshCliOAuth,
  type CliOAuthDeps,
  type CliOAuthSource,
} from '@process/utils/importCliOAuthOnBoot';

function makeDeps(
  states: Record<string, string | undefined>,
  reuse: Record<string, CliOAuthSource['reuse']>
): CliOAuthDeps & { logs: string[]; warns: string[] } {
  const logs: string[] = [];
  const warns: string[] = [];
  const sources: CliOAuthSource[] = Object.entries(reuse).map(([providerId, fn]) => ({
    providerId,
    label: `${providerId} CLI login`,
    loginHint: `${providerId} login --device-auth`,
    reuse: fn,
  }));
  return {
    getProviderState: (id) => states[id],
    sources,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    logs,
    warns,
  };
}

describe('importCliOAuthOnBoot', () => {
  it('skips providers that are already connected without touching the CLI login', async () => {
    const reuse = vi.fn(async () => ({ ok: true }));
    const deps = makeDeps({ xai: 'connected' }, { xai: reuse });
    await importCliOAuthOnBoot(deps);
    expect(reuse).not.toHaveBeenCalled();
    expect(deps.logs).toEqual([]);
  });

  it('registers a usable CLI login and logs the reuse', async () => {
    const reuse = vi.fn(async () => ({ ok: true }));
    const deps = makeDeps({}, { 'chatgpt-subscription': reuse });
    await importCliOAuthOnBoot(deps);
    expect(reuse).toHaveBeenCalledTimes(1);
    expect(deps.logs[0]).toContain('Reused chatgpt-subscription CLI login');
    expect(deps.warns).toEqual([]);
  });

  it('prints the headless login hint when no usable CLI login exists', async () => {
    const deps = makeDeps({}, { xai: async () => null });
    await importCliOAuthOnBoot(deps);
    expect(deps.logs[0]).toContain('xai login --device-auth');
    expect(deps.warns).toEqual([]);
  });

  it('warns, never throws, when registration fails or the reuse throws', async () => {
    const deps = makeDeps(
      {},
      {
        xai: async () => ({ ok: false, error: 'unauthorized' }),
        'chatgpt-subscription': async () => {
          throw new Error('boom');
        },
      }
    );
    await expect(importCliOAuthOnBoot(deps)).resolves.toBeUndefined();
    expect(deps.warns).toHaveLength(2);
    expect(deps.warns[0]).toContain('unauthorized');
    expect(deps.warns[1]).toContain('boom');
    expect(deps.warns.join('\n')).not.toMatch(/eyJ|sk-/);
  });

  it('refresh re-registers even when already connected, and stays quiet on a missing login', async () => {
    const reuse = vi.fn(async () => ({ ok: true }));
    const missing = vi.fn(async () => null);
    const deps = makeDeps({ xai: 'connected', 'chatgpt-subscription': 'connected' }, { xai: reuse, 'chatgpt-subscription': missing });
    await refreshCliOAuth(deps);
    expect(reuse).toHaveBeenCalledTimes(1);
    expect(missing).toHaveBeenCalledTimes(1);
    expect(deps.logs).toHaveLength(1);
  });

  it('is a no-op when the registry is not initialized', async () => {
    await expect(importCliOAuthOnBoot(null)).resolves.toBeUndefined();
    await expect(refreshCliOAuth(null)).resolves.toBeUndefined();
  });
});
