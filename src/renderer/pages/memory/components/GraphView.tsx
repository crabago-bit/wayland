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

import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { MemoryGraph } from '@/common/types/memory';
import { categoryOf } from '../categories';
import { GRAPH_HEIGHT, GRAPH_WIDTH, layoutGraph } from '../graphLayout';
import styles from './GraphView.module.css';

export type GraphViewProps = {
  graph: MemoryGraph | null;
  isLoading: boolean;
  error: string | null;
  selectedId?: string;
  onSelect?: (id: string) => void;
};

type View = { x: number; y: number; k: number };
const FIT: View = { x: 0, y: 0, k: 1 };

const GraphView: React.FC<GraphViewProps> = ({ graph, isLoading, error, selectedId, onSelect }) => {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [view, setView] = useState<View>(FIT);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

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

  const onWheel = useCallback((e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => ({ ...v, k: Math.min(6, Math.max(0.5, v.k * factor)) }));
  }, []);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) {
      d.x = e.clientX;
      d.y = e.clientY;
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  }, []);
  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

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
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
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
            const dim = focusSet ? !focusSet.has(n.id) : false;
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
                  if (!drag.current?.moved) onSelect?.(n.id);
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
        <button type='button' className={styles.reset} onClick={() => setView(FIT)}>
          Reset view
        </button>
      </div>
    </div>
  );
};

export default GraphView;
