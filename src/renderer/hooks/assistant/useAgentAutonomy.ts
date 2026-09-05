/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConfigStorage } from '@/common/config/storage';
import { ipcBridge } from '@/common';
import { DEFAULT_AUTONOMY_RUNG, toAutonomyRung, type AutonomyRung } from '@/common/jarvis/autonomy';
import { useCallback, useMemo } from 'react';
import useSWR from 'swr';

/** SWR key for the persisted per-agent rung map (single source of truth). */
export const AGENT_AUTONOMY_SWR_KEY = 'agents.autonomy';

/** SWR key for the hard floor, which is read from disk, not from settings. */
export const HARD_FLOOR_SWR_KEY = 'jarvis.hardFloor';

/**
 * Shared, reactive view of the JARVIS autonomy rung each agent sits on.
 *
 * Backed by `ConfigStorage('agents.autonomy')` behind one SWR key, exactly like
 * `useHiddenAgents` - the two settings describe the same agent from the same
 * page and use the same key format (plain backend, `custom:uuid`, `remote:uuid`),
 * so keeping them on one mechanism means one identity scheme instead of two.
 *
 * The value shown here is NOT the enforcement. The rung is applied in the MCP
 * tool-filter shim at `tools/call` time; this hook only reads and writes what
 * the shim is later spawned with.
 */
export function useAgentAutonomy() {
  const { data, mutate } = useSWR<Record<string, AutonomyRung>>(AGENT_AUTONOMY_SWR_KEY, async () => {
    const stored = await ConfigStorage.get('agents.autonomy');
    return stored ?? {};
  });

  const rungs = useMemo(() => data ?? {}, [data]);

  /** An agent with no entry has never been promoted, so it is on rung 1. */
  const rungOf = useCallback(
    (agentKey: string): AutonomyRung => toAutonomyRung(rungs[agentKey] ?? DEFAULT_AUTONOMY_RUNG),
    [rungs]
  );

  const setRung = useCallback(
    async (agentKey: string, rung: AutonomyRung) => {
      const current = (await ConfigStorage.get('agents.autonomy')) ?? {};
      const next = { ...current, [agentKey]: rung };
      await ConfigStorage.set('agents.autonomy', next);
      // Bound mutate so every consumer of this key revalidates without a reload.
      await mutate(next, { revalidate: false });
    },
    [mutate]
  );

  return { rungs, rungOf, setRung };
}

export type HardFloorInfo = { pattern: string; keywords: string[]; notesPath: string };

/**
 * The effective hard floor, read from the main process.
 *
 * Read-only on purpose: the built-in pattern ships in code and the operator's
 * extra keywords come from `~/.claude/crew-state/autonomy.md`. Making it
 * editable from settings would let the app talk itself out of its own floor.
 */
export function useHardFloor() {
  const { data } = useSWR<HardFloorInfo>(HARD_FLOOR_SWR_KEY, async () => {
    return await ipcBridge.jarvis.hardFloor.invoke();
  });
  return data ?? { pattern: '', keywords: [], notesPath: '' };
}
