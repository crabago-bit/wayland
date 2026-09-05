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
 * An unknown or absent key resolves to `DEFAULT_AUTONOMY_RUNG` (3, ACT ->
 * REPORT) - see that constant for why an absent entry is an existing install
 * rather than a new agent. A storage FAILURE is a different thing and does not
 * resolve there; see {@link getAutonomyRung}.
 */

import { toAutonomyRung, type AutonomyRung } from '@/common/jarvis/autonomy';
import type { ToolFilterSpawnAutonomy } from '@process/services/mcpServices/builtinMcpRuntime';
import { ProcessConfig } from '@process/utils/initStorage';
import { resolveApprovalsLogPath } from './approvalsPath';
import { readHardFloorKeywords } from './hardFloor';

/**
 * The rung used when the rung store cannot be read at all: 2, DRAFT -> APPROVE.
 */
export const STORAGE_FAILURE_RUNG: AutonomyRung = 2;

/** The persisted rung for one agent key. */
export async function getAutonomyRung(agentKey: string): Promise<AutonomyRung> {
  try {
    const stored = await ProcessConfig.get('agents.autonomy');
    return toAutonomyRung(stored?.[agentKey]);
  } catch {
    // Fail TOWARD approval. An ABSENT entry means "an install nobody has
    // configured", which the default rung is chosen for; an unreadable store
    // means we do not know what the operator picked, and the one rung that is
    // wrong in both directions is the one that acts on that ignorance. Rung 2
    // still drafts and still reads - the agent keeps working, it just asks
    // before it sends - so a transient storage fault degrades to a prompt
    // rather than to an unattended write or to a dead assistant.
    return STORAGE_FAILURE_RUNG;
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
