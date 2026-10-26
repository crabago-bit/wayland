/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { memory as memoryBridge } from '@/common/adapter/ipcBridge';
import type { ListFilter, MemoryGraph } from '@/common/types/memory';

export type UseMemoryGraphResult = { graph: MemoryGraph | null; isLoading: boolean; error: string | null };

/** Fetches the memory graph for the category and workspace filters; `enabled` keeps the List view free of the cost. */
export function useMemoryGraph(filter: ListFilter, enabled: boolean): UseMemoryGraphResult {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typesKey = (filter.types ?? []).join(',');
  const project = filter.project;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const next = await memoryBridge.getGraph.invoke({
          types: typesKey ? typesKey.split(',') : undefined,
          project,
        });
        if (!cancelled) setGraph(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, typesKey, project]);

  return { graph, isLoading, error };
}
