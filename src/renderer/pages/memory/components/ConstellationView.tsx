/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ConstellationView - the Memory graph as a round star chart. One disc holds every memory, cut
 * into a wedge per category; inside a wedge the best-connected memories sit nearest the centre.
 * Lines inside a wedge join neighbouring stars into that category's figure, so each category is
 * one connected shape, and curves across the sky are real links (memories that mention the same
 * file, host or identifier). Click a star to open it; drag to pan, scroll to zoom.
 */

import React, { useMemo, useState } from 'react';
import type { MemoryGraph } from '@/common/types/memory';
import { MEMORY_CATEGORIES, categoryOf } from '../categories';
import {
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  SKY_CX,
  SKY_CY,
  SKY_RADIUS,
  arcPath,
  layoutSky,
  skyLines,
  type Point,
  type Sector,
} from '../graphLayout';
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
const RIM = SKY_RADIUS + 14;
const TICKS = Array.from({ length: 72 }, (_, i) => (i / 72) * Math.PI * 2);

const polar = (angle: number, radius: number): Point => ({
  x: SKY_CX + Math.cos(angle) * radius,
  y: SKY_CY + Math.sin(angle) * radius,
});

/** SVG arc along the rim for one wedge. */
const rimArc = (sector: Sector): string => {
  const a = polar(sector.start, RIM);
  const b = polar(sector.end, RIM);
  const large = sector.end - sector.start > Math.PI ? 1 : 0;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${RIM} ${RIM} 0 ${large} 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
};

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

  const sky = useMemo(() => {
    if (!graph) return null;
    const nodes = graph.nodes.map((n) => ({ id: n.id, type: n.type, degree: n.degree }));
    const { positions, sectors } = layoutSky(nodes, ORDER);
    return { positions, sectors, lines: skyLines(nodes, positions) };
  }, [graph]);
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
  if (!graph || !sky || (isLoading && graph.nodes.length === 0)) {
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
  const hoveredPos = hoverId ? sky.positions.get(hoverId) : undefined;

  return (
    <div className={styles.wrap} data-testid='memory-constellation'>
      <svg
        className={styles.canvas}
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        role='img'
        aria-label={`Round star chart of ${graph.nodes.length} linked memories in ${sky.sectors.length} categories`}
        {...pan.handlers}
      >
        <defs>
          <radialGradient id='sky-disc' cx='50%' cy='45%' r='65%'>
            <stop offset='0%' stopColor='#1a2142' />
            <stop offset='70%' stopColor='#0a0d1c' />
            <stop offset='100%' stopColor='#05060f' />
          </radialGradient>
          {MEMORY_CATEGORIES.map((c) => (
            <radialGradient key={c.type} id={`star-${c.type}`}>
              <stop offset='0%' stopColor={c.color} stopOpacity='0.9' />
              <stop offset='100%' stopColor={c.color} stopOpacity='0' />
            </radialGradient>
          ))}
          <clipPath id='sky-clip'>
            <circle cx={SKY_CX} cy={SKY_CY} r={RIM} />
          </clipPath>
        </defs>
        <g transform={pan.transform}>
          <circle cx={SKY_CX} cy={SKY_CY} r={RIM} fill='url(#sky-disc)' data-testid='memory-constellation-disc' />
          <circle cx={SKY_CX} cy={SKY_CY} r={RIM + 8} className={styles.outerRim} />
          {TICKS.map((angle, i) => {
            const a = polar(angle, RIM + 1);
            const b = polar(angle, RIM + (i % 6 === 0 ? 8 : 4));
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={styles.tick} />;
          })}
          {sky.sectors.map((sector) => {
            const cat = categoryOf(sector.type as never);
            const inner = polar(sector.start, SKY_RADIUS * 0.06);
            const outer = polar(sector.start, RIM);
            const label = polar(sector.mid, RIM + 26);
            const side = Math.cos(sector.mid);
            return (
              <g key={sector.type} data-testid={`memory-constellation-cluster-${sector.type}`}>
                <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} className={styles.divider} />
                <path d={rimArc(sector)} fill='none' stroke={cat.color} strokeWidth={3} strokeOpacity={0.8} />
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor={Math.abs(side) < 0.25 ? 'middle' : side > 0 ? 'start' : 'end'}
                  dominantBaseline='middle'
                  className={styles.sectorLabel}
                >
                  {cat.glyph} {cat.label} · {sector.count.toLocaleString()}
                </text>
              </g>
            );
          })}
          <g clipPath='url(#sky-clip)'>
            {graph.edges.map((e) => {
              const a = sky.positions.get(e.source);
              const b = sky.positions.get(e.target);
              if (!a || !b) return null;
              const lit = focusId !== null && (e.source === focusId || e.target === focusId);
              return (
                <path
                  key={`${e.source}-${e.target}`}
                  d={arcPath(a, b)}
                  className={lit ? styles.linkLit : styles.link}
                  strokeOpacity={focusSet && !lit ? 0.03 : undefined}
                />
              );
            })}
            {sky.lines.map((l) => {
              const a = sky.positions.get(l.a);
              const b = sky.positions.get(l.b);
              const type = nodeById.get(l.a)?.type;
              if (!a || !b || !type) return null;
              return (
                <line
                  key={`${l.a}~${l.b}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={categoryOf(type).color}
                  className={styles.figure}
                  strokeOpacity={focusSet ? 0.12 : undefined}
                />
              );
            })}
          </g>
          {graph.nodes.map((n) => {
            const p = sky.positions.get(n.id);
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
          {graph.totalEntries.toLocaleString()} memories link to another · lines join neighbours in a category, curves
          are shared files, hosts and identifiers
        </span>
        <button type='button' className={styles.reset} onClick={pan.reset}>
          Reset view
        </button>
      </div>
    </div>
  );
};

export default ConstellationView;
