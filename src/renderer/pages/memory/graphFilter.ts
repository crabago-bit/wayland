/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemoryGraph } from '@/common/types/memory';

/** Keep only memories with at least `minLinks` links, and the links between those that remain. */
export function filterGraph(graph: MemoryGraph | null, minLinks: number): MemoryGraph | null {
  if (!graph || minLinks <= 1) return graph;
  const nodes = graph.nodes.filter((n) => n.degree >= minLinks);
  const keep = new Set(nodes.map((n) => n.id));
  return { ...graph, nodes, edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
}

/** Ids of memories whose title contains the search text (case-insensitive); empty search matches none. */
export function matchingIds(graph: MemoryGraph | null, search: string | undefined): Set<string> | null {
  const q = (search ?? '').trim().toLowerCase();
  if (!graph || q.length < 2) return null;
  return new Set(graph.nodes.filter((n) => n.summary.toLowerCase().includes(q)).map((n) => n.id));
}
