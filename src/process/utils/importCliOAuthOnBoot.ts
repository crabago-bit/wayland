/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Headless-server counterpart of the desktop "Sign in with ChatGPT" / "Sign in
 * with X" buttons.
 *
 * Both native OAuth flows are remote-denied for every WebUI client
 * (`bridgeAllowlist.ts`: a paired browser must never mint a credential), and a
 * headless server has no desktop window to click. But the CLI logins the flows
 * already know how to reuse are plain files on the same box:
 *
 *   ~/.codex/auth.json  - Codex CLI   -> `chatgpt-subscription` provider
 *   ~/.grok/auth.json   - Grok CLI    -> `xai` provider
 *
 * Both are produced headlessly by `codex login --device-auth` and
 * `grok login --device-auth`. This module mirrors `importEnvKeysOnBoot`: at
 * boot, for each provider that is not already `connected`, reuse the CLI login
 * (refreshing an expired access token with the CLI refresh token) and register
 * it. A periodic tick re-runs the reuse so the registry key tracks the CLI's
 * rotating access token instead of going stale after a day.
 *
 * Idempotent, never throws, never logs token values, never opens a browser.
 */

import { chatgptReuseCliLogin } from '@process/onboarding/chatgptOAuth';
import { xaiReuseCliLogin } from '@process/onboarding/xaiOAuth';
import { getModelRegistryRepository } from '@process/providers/ipc/modelRegistryIpc';

/** Minimal shape of a reuse result - both OAuth modules return `{ ok, error? }`. */
export type CliOAuthReuseResult = { ok: boolean; error?: string } | null;

export type CliOAuthSource = {
  /** Registry provider id this CLI login feeds. */
  providerId: string;
  /** Human label for logs. */
  label: string;
  /** The headless command that (re)creates the CLI login. */
  loginHint: string;
  /** Reuse + register; `null` when no usable CLI login exists. */
  reuse: () => Promise<CliOAuthReuseResult>;
};

export type CliOAuthDeps = {
  /** Returns the registry state for a provider id, or undefined when unknown. */
  getProviderState: (providerId: string) => string | undefined;
  sources: readonly CliOAuthSource[];
  log: (message: string) => void;
  warn: (message: string) => void;
};

export const DEFAULT_CLI_OAUTH_SOURCES: readonly CliOAuthSource[] = [
  {
    providerId: 'chatgpt-subscription',
    label: 'Codex CLI login',
    loginHint: 'codex login --device-auth',
    reuse: chatgptReuseCliLogin,
  },
  {
    providerId: 'xai',
    label: 'Grok CLI login',
    loginHint: 'grok login --device-auth',
    reuse: xaiReuseCliLogin,
  },
];

/** Re-run the reuse hourly so a CLI-rotated access token reaches the registry before the old one expires. */
export const CLI_OAUTH_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

function defaultDeps(): CliOAuthDeps | null {
  const repo = getModelRegistryRepository();
  if (!repo) return null;
  return {
    getProviderState: (id) => repo.getRegistryProvider(id)?.state,
    sources: DEFAULT_CLI_OAUTH_SOURCES,
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };
}

/**
 * Reuse one CLI login into the registry. `force` re-registers even when the
 * provider is already connected (the periodic refresh path).
 */
async function reuseOne(source: CliOAuthSource, deps: CliOAuthDeps, force: boolean): Promise<void> {
  if (!force && deps.getProviderState(source.providerId) === 'connected') return;
  let result: CliOAuthReuseResult;
  try {
    result = await source.reuse();
  } catch (error) {
    deps.warn(`[server] ${source.label} reuse threw for ${source.providerId}: ${describe(error)}`);
    return;
  }
  if (result === null) {
    if (!force) {
      deps.log(
        `[server] No usable ${source.label} for ${source.providerId}; run \`${source.loginHint}\` on this host to enable it.`
      );
    }
    return;
  }
  if (result.ok) {
    deps.log(`[server] Reused ${source.label} for ${source.providerId}`);
    return;
  }
  deps.warn(`[server] ${source.label} for ${source.providerId} failed to register: ${result.error ?? 'unknown'}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Boot-time import: registers CLI logins for providers not already connected. */
export async function importCliOAuthOnBoot(deps: CliOAuthDeps | null = defaultDeps()): Promise<void> {
  if (!deps) {
    console.warn('[server] Skipping CLI OAuth reuse: model registry not initialized');
    return;
  }
  for (const source of deps.sources) {
    await reuseOne(source, deps, false);
  }
}

/** Periodic refresh: re-registers every CLI login that still exists. */
export async function refreshCliOAuth(deps: CliOAuthDeps | null = defaultDeps()): Promise<void> {
  if (!deps) return;
  for (const source of deps.sources) {
    await reuseOne(source, deps, true);
  }
}

/** Schedule `refreshCliOAuth` on an unref'd timer so it never holds the process open. */
export function scheduleCliOAuthRefresh(intervalMs: number = CLI_OAUTH_REFRESH_INTERVAL_MS): NodeJS.Timeout {
  const timer = setInterval(() => {
    void refreshCliOAuth().catch((error) => console.warn('[server] CLI OAuth refresh failed:', describe(error)));
  }, intervalMs);
  timer.unref();
  return timer;
}
