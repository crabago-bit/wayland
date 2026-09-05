/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { isElectronDesktop } from '@renderer/utils/platform';
import type { ApprovalRecord } from '@process/services/jarvis/approvalsLog';
import type { HardFloorInfo } from '@renderer/hooks/assistant/useAgentAutonomy';

const EMPTY_FLOOR: HardFloorInfo = { builtinTokens: [], keywords: [], notesFileFound: false };

export type ApprovalsFilter = { decision: 'all' | 'refused' | 'allowed'; agent: string };

type Bundle = { approvals: ApprovalRecord[]; hardFloor: HardFloorInfo };

/**
 * Load the approvals ledger over whichever rail this renderer actually has.
 *
 * Desktop uses `ipcBridge.jarvis.*`. A browser WebUI cannot: the whole `jarvis.`
 * namespace is denied to remote callers at the WS adapter, so it reads the
 * token-authed `GET /api/jarvis/approvals` instead. Both rails are served by the
 * SAME main-process reader, so the two views cannot disagree about what happened.
 */
async function fetchBundle(): Promise<Bundle> {
  if (isElectronDesktop()) {
    const [approvals, hardFloor] = await Promise.all([
      ipcBridge.jarvis.approvals.invoke({}),
      ipcBridge.jarvis.hardFloor.invoke(),
    ]);
    return { approvals, hardFloor };
  }
  const res = await fetch('/api/jarvis/approvals', { credentials: 'include' });
  if (!res.ok) return { approvals: [], hardFloor: EMPTY_FLOOR };
  const body = (await res.json()) as { data?: Partial<Bundle> };
  return { approvals: body.data?.approvals ?? [], hardFloor: body.data?.hardFloor ?? EMPTY_FLOOR };
}

export function useApprovals() {
  const [filter, setFilter] = useState<ApprovalsFilter>({ decision: 'all', agent: 'all' });

  const { data, isLoading, mutate } = useSWR<Bundle>('jarvis/approvals', fetchBundle, {
    revalidateOnFocus: true,
    refreshInterval: 30_000,
  });

  const approvals = useMemo(() => data?.approvals ?? [], [data]);

  // Agent options come from the rows themselves rather than from the agent
  // registry: an agent that never attempted a tool call has nothing to filter.
  const agents = useMemo(() => [...new Set(approvals.map((r) => r.agent).filter(Boolean))].toSorted(), [approvals]);

  const rows = useMemo(
    () =>
      approvals.filter(
        (r) =>
          (filter.decision === 'all' || r.decision === filter.decision) &&
          (filter.agent === 'all' || r.agent === filter.agent)
      ),
    [approvals, filter]
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return {
    rows,
    agents,
    filter,
    setFilter,
    hardFloor: data?.hardFloor ?? EMPTY_FLOOR,
    total: approvals.length,
    loading: isLoading,
    refresh,
  };
}
