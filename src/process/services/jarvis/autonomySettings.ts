/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host-side resolution of one agent's rung into the snapshot the tool filter
 * shim is spawned with.
 *
 * The rung is persisted in `ConfigStorage['agents.autonomy']`, keyed the same
 * way `agents.hidden` is (plain backend, `custom:uuid`, `remote:uuid`) so the
 * Agents settings page can write both from one agent record without a second
 * identity scheme. That is also why there is no migration here: per-agent UI
 * state on this page has never lived in SQLite.
 *
 * An unknown or absent key resolves to `DEFAULT_AUTONOMY_RUNG` (1, SUGGEST) -
 * an agent nobody has promoted has not been promoted.
 */

import { DEFAULT_AUTONOMY_RUNG, toAutonomyRung, type AutonomyRung } from '@/common/jarvis/autonomy';
import type { ToolFilterSpawnAutonomy } from '@process/services/mcpServices/builtinMcpRuntime';
import { ProcessConfig } from '@process/utils/initStorage';
import { resolveApprovalsLogPath } from './approvalsPath';
import { readHardFloorKeywords } from './hardFloor';

/** The persisted rung for one agent key. */
export async function getAutonomyRung(agentKey: string): Promise<AutonomyRung> {
  try {
    const stored = await ProcessConfig.get('agents.autonomy');
    return toAutonomyRung(stored?.[agentKey]);
  } catch {
    // A storage read failure must not promote anybody.
    return DEFAULT_AUTONOMY_RUNG;
  }
}

/**
 * Everything the shim needs for one spawn: whose ladder, which rung, the
 * operator's extra floor keywords, and where to write the ledger.
 */
export async function resolveSpawnAutonomy(agentKey: string): Promise<ToolFilterSpawnAutonomy> {
  return {
    agent: agentKey,
    rung: await getAutonomyRung(agentKey),
    hardFloorKeywords: readHardFloorKeywords(),
    logPath: resolveApprovalsLogPath(),
  };
}
