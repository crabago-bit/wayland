/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/** True when the process runs under a CI system (used to keep updaters and the like off). */
export function isCiRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.CI === 'true' || env.CI === '1' || env.GITHUB_ACTIONS === 'true';
}
