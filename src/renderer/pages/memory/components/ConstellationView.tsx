/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ConstellationView - the Memory graph as a night sky. Each category is its own cluster of
 * stars; a star's brightness and size grow with how many other memories it shares something
 * with, and faint lines run between related memories, including across clusters. Click a star
 * to open it; drag to pan, scroll to zoom.
 */

import React, { useMemo, useState } from 'react';
import type { MemoryGraph } from '@/common/types/memory';
import { MEMORY_CATEGORIES, categoryOf } from '../categories';
import { GRAPH_HEIGHT, GRAPH_WIDTH, layoutClusters, type Cluster, type Point } from '../graphLayout';
import { usePanZoom } from '../hooks/usePanZoom';
import styles from './ConstellationView.module.css';

export type ConstellationViewProps = {
  graph: MemoryGraph | null;
  isLoading: boolean;
  error: string | null;
  selectedId?: string;
  onSelect?: (id: string) => void;
  highlightIds?: Set<string> | null;
};

const ORDER = MEMORY_CATEGORIES.map((c) => c.type);

const ConstellationView: React.FC<ConstellationViewProps> = ({
  graph,
  isLoading,
  error,
  selectedId,
  onSelect,
  highlightIds,
}) => {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const pan = usePanZoom();

  const layout = useMemo(
    () =>
      graph
        ? layoutClusters(graph.nodes, graph.edges, ORDER)
        : { positions: new Map<string, Point>(), clusters: [] as Cluster[] },
    [graph]
  );
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of graph?.edges ?? []) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    }
    return map;
  }, [graph]);
  const focusId = hoverId ?? selectedId ?? null;
  const focusSet = useMemo(
    () => (focusId ? new Set([focusId, ...(neighbours.get(focusId) ?? [])]) : null),
    [focusId, neighbours]
  );

  if (error) {
    return (
      <div className={styles.message} data-testid='memory-constellation-error' role='alert'>
        Couldn&apos;t build the constellation: {error}
      </div>
    );
  }
  if (!graph || (isLoading && graph.nodes.length === 0)) {
    return (
      <div className={styles.message} data-testid='memory-constellation-loading' role='status' aria-busy='true'>
        Charting your memories…
      </div>
    );
  }
  if (graph.nodes.length === 0) {
    return (
      <div className={styles.message} data-testid='memory-constellation-empty'>
        No memories here share anything specific with each other yet. Try All categories.
      </div>
    );
  }

  const hovered = hoverId ? nodeById.get(hoverId) : undefined;
  const hoveredPos = hoverId ? layout.positions.get(hoverId) : undefined;

  return (
    <div className={styles.wrap} data-testid='memory-constellation'>
      <svg
        className={styles.sky}
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        role='img'
        aria-label={`Constellation of ${graph.nodes.length} linked memories in ${layout.clusters.length} clusters`}
        {...pan.handlers}
      >
        <defs>
          {MEMORY_CATEGORIES.map((c) => (
            <radialGradient key={c.type} id={`star-${c.type}`}>
              <stop offset='0%' stopColor={c.color} stopOpacity='0.9' />
              <stop offset='100%' stopColor={c.color} stopOpacity='0' />
            </radialGradient>
          ))}
        </defs>
        <g transform={pan.transform}>
          {layout.clusters.map((c) => {
            const cat = categoryOf(c.type as never);
            return (
              <g key={c.type} data-testid={`memory-constellation-cluster-${c.type}`}>
                <circle cx={c.x} cy={c.y} r={c.radius * 1.5} fill={`url(#star-${c.type})`} opacity={0.1} />
                <text x={c.x} y={c.y - c.radius * 1.5 - 6} textAnchor='middle' className={styles.clusterLabel}>
                  {cat.glyph} {cat.label} · {c.count.toLocaleString()}
                </text>
              </g>
            );
          })}
          {graph.edges.map((e) => {
            const a = layout.positions.get(e.source);
            const b = layout.positions.get(e.target);
            if (!a || !b) return null;
            const lit = focusId !== null && (e.source === focusId || e.target === focusId);
            return (
              <line
                key={`${e.source}-${e.target}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={lit ? styles.lineLit : styles.line}
                strokeOpacity={focusSet && !lit ? 0.04 : undefined}
              />
            );
          })}
          {graph.nodes.map((n) => {
            const p = layout.positions.get(n.id);
            if (!p) return null;
            const core = 2 + Math.min(5, n.degree * 0.8);
            const dim = focusSet ? !focusSet.has(n.id) : highlightIds ? !highlightIds.has(n.id) : false;
            const color = categoryOf(n.type).color;
            return (
              <g
                key={n.id}
                opacity={dim ? 0.15 : 1}
                className={styles.star}
                tabIndex={0}
                role='button'
                aria-label={n.summary}
                data-testid={`memory-constellation-star-${n.id}`}
                onPointerEnter={() => setHoverId(n.id)}
                onPointerLeave={() => setHoverId(null)}
                onFocus={() => setHoverId(n.id)}
                onBlur={() => setHoverId(null)}
                onClick={() => {
                  if (!pan.moved()) onSelect?.(n.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(n.id);
                  }
                }}
              >
                <circle cx={p.x} cy={p.y} r={core * 3.2} fill={`url(#star-${n.type})`} opacity={0.55} />
                <circle cx={p.x} cy={p.y} r={core} fill={color} />
                {n.id === selectedId ? <circle cx={p.x} cy={p.y} r={core + 4} className={styles.ring} /> : null}
              </g>
            );
          })}
          {hovered && hoveredPos ? (
            <text x={hoveredPos.x + 12} y={hoveredPos.y - 10} className={styles.label}>
              {hovered.summary.length > 70 ? `${hovered.summary.slice(0, 70)}…` : hovered.summary}
            </text>
          ) : null}
        </g>
      </svg>
      <div className={styles.footer} data-testid='memory-constellation-footer'>
        <span>
          {graph.nodes.length.toLocaleString()} stars · {graph.linked.toLocaleString()} of{' '}
          {graph.totalEntries.toLocaleString()} memories link to another
        </span>
        <button type='button' className={styles.reset} onClick={pan.reset}>
          Reset view
        </button>
      </div>
    </div>
  );
};

export default ConstellationView;
