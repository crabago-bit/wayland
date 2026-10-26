/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GraphView - the Memory constellation. Each dot is a memory, coloured by category and sized by
 * how many others it shares something with; a line joins two memories that mention the same
 * file, host or identifier. Click a dot to open it; drag to pan, scroll to zoom.
 */

import React, { useMemo, useState } from 'react';
import type { MemoryGraph } from '@/common/types/memory';
import { categoryOf } from '../categories';
import { GRAPH_HEIGHT, GRAPH_WIDTH, layoutGraph } from '../graphLayout';
import { usePanZoom } from '../hooks/usePanZoom';
import styles from './GraphView.module.css';

export type GraphViewProps = {
  graph: MemoryGraph | null;
  isLoading: boolean;
  error: string | null;
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Memories matching the search box; they stay bright while the rest dim. */
  highlightIds?: Set<string> | null;
};

/** How many of the best-connected memories always show their title. */
const LABELLED = 10;

const GraphView: React.FC<GraphViewProps> = ({ graph, isLoading, error, selectedId, onSelect, highlightIds }) => {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const pan = usePanZoom();

  const positions = useMemo(
    () => (graph ? layoutGraph(graph.nodes, graph.edges) : new Map<string, { x: number; y: number }>()),
    [graph]
  );
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
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);

  const labelled = useMemo(
    () =>
      new Set(
        [...(graph?.nodes ?? [])]
          .sort((x, y) => y.degree - x.degree)
          .slice(0, LABELLED)
          .map((n) => n.id)
      ),
    [graph]
  );

  if (error) {
    return (
      <div className={styles.message} data-testid='memory-graph-error' role='alert'>
        Couldn&apos;t build the graph: {error}
      </div>
    );
  }
  if (!graph || (isLoading && graph.nodes.length === 0)) {
    return (
      <div className={styles.message} data-testid='memory-graph-loading' role='status' aria-busy='true'>
        Mapping your memories…
      </div>
    );
  }
  if (graph.nodes.length === 0) {
    return (
      <div className={styles.message} data-testid='memory-graph-empty'>
        No memories here share anything specific with each other yet. Try All categories.
      </div>
    );
  }

  const hovered = hoverId ? nodeById.get(hoverId) : undefined;
  const hoveredPos = hoverId ? positions.get(hoverId) : undefined;

  return (
    <div className={styles.wrap} data-testid='memory-graph'>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        role='img'
        aria-label={`Graph of ${graph.nodes.length} linked memories`}
        {...pan.handlers}
      >
        <g transform={pan.transform}>
          {graph.edges.map((e) => {
            const a = positions.get(e.source);
            const b = positions.get(e.target);
            if (!a || !b) return null;
            const lit = focusSet
              ? focusSet.has(e.source) && focusSet.has(e.target) && (e.source === focusId || e.target === focusId)
              : false;
            return (
              <line
                key={`${e.source}-${e.target}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={lit ? styles.edgeLit : styles.edge}
                strokeOpacity={focusSet && !lit ? 0.08 : undefined}
              />
            );
          })}
          {graph.nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const color = categoryOf(n.type)?.color ?? '#9CA3AF';
            const dim = focusSet ? !focusSet.has(n.id) : highlightIds ? !highlightIds.has(n.id) : false;
            return (
              <circle
                key={n.id}
                cx={p.x}
                cy={p.y}
                r={4 + Math.min(10, n.degree * 1.2)}
                fill={color}
                className={`${styles.node}${n.id === selectedId ? ` ${styles.nodeSelected}` : ''}`}
                opacity={dim ? 0.2 : 0.9}
                tabIndex={0}
                role='button'
                aria-label={n.summary}
                data-testid={`memory-graph-node-${n.id}`}
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
              />
            );
          })}
          {graph.nodes
            .filter((n) => (labelled.has(n.id) || highlightIds?.has(n.id)) && n.id !== hoverId)
            .map((n) => {
              const p = positions.get(n.id);
              return p ? (
                <text key={`l-${n.id}`} x={p.x + 10} y={p.y - 8} className={styles.labelQuiet}>
                  {n.summary.length > 36 ? `${n.summary.slice(0, 36)}…` : n.summary}
                </text>
              ) : null;
            })}
          {hovered && hoveredPos ? (
            <text x={hoveredPos.x + 12} y={hoveredPos.y - 10} className={styles.label}>
              {hovered.summary.length > 70 ? `${hovered.summary.slice(0, 70)}…` : hovered.summary}
            </text>
          ) : null}
        </g>
      </svg>
      <div className={styles.footer} data-testid='memory-graph-footer'>
        <span>
          {graph.nodes.length.toLocaleString()} shown · {graph.linked.toLocaleString()} of{' '}
          {graph.totalEntries.toLocaleString()} memories link to another
          {graph.unlinked > 0 ? ` · ${graph.unlinked.toLocaleString()} stand alone (mostly logs)` : ''}
        </span>
        <button type='button' className={styles.reset} onClick={pan.reset}>
          Reset view
        </button>
      </div>
    </div>
  );
};

export default GraphView;
