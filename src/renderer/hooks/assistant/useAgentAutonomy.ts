/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConfigStorage } from '@/common/config/storage';
import { ipcBridge } from '@/common';
import {
  DEFAULT_AUTONOMY_RUNG,
  toAutonomyRung,
  type AutonomyRung,
  type HardFloorInfo as HardFloorInfoShape,
} from '@/common/jarvis/autonomy';
import { Message } from '@arco-design/web-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const { data, mutate } = useSWR<Record<string, AutonomyRung>>(AGENT_AUTONOMY_SWR_KEY, async () => {
    const stored = await ConfigStorage.get('agents.autonomy');
    return stored ?? {};
  });

  const rungs = useMemo(() => data ?? {}, [data]);

  /** An agent with no entry sits on `DEFAULT_AUTONOMY_RUNG` - see that constant. */
  const rungOf = useCallback(
    (agentKey: string): AutonomyRung => toAutonomyRung(rungs[agentKey] ?? DEFAULT_AUTONOMY_RUNG),
    [rungs]
  );

  /**
   * Persist one agent's rung.
   *
   * `agents.autonomy` is on `REMOTE_DENIED_CONFIG_KEY_PREFIXES`, so this write
   * REJECTS when the page is being served to a paired device - a peer that
   * could set its own rung to 4 would be promoting itself past the ladder. The
   * rejection has to be caught here: an unhandled one leaves the Select showing
   * the rung the user picked while the store still holds the old value, which
   * is the one failure mode a security control cannot afford - it looks like it
   * worked. On failure the cache is left alone, so the control snaps back to
   * the rung that is actually in force.
   */
  const setRung = useCallback(
    async (agentKey: string, rung: AutonomyRung) => {
      try {
        const current = (await ConfigStorage.get('agents.autonomy')) ?? {};
        const next = { ...current, [agentKey]: rung };
        await ConfigStorage.set('agents.autonomy', next);
        // Bound mutate so every consumer of this key revalidates without a reload.
        await mutate(next, { revalidate: false });
      } catch {
        Message.error(
          t(
            'settings.agentsPage.autonomy.remoteDenied',
            'Autonomy can only be changed from the desktop app, not a paired device'
          )
        );
        await mutate();
      }
    },
    [mutate, t]
  );

  return { rungs, rungOf, setRung };
}

export type { HardFloorInfo } from '@/common/jarvis/autonomy';

/**
 * The effective hard floor, read from the main process.
 *
 * Read-only on purpose: the built-in pattern ships in code and the operator's
 * extra keywords come from `~/.claude/crew-state/autonomy.md`. Making it
 * editable from settings would let the app talk itself out of its own floor.
 */
export function useHardFloor() {
  const { data } = useSWR<HardFloorInfoShape>(HARD_FLOOR_SWR_KEY, async () => {
    return await ipcBridge.jarvis.hardFloor.invoke();
  });
  return data ?? { builtinTokens: [], keywords: [], notesFileFound: false };
}
