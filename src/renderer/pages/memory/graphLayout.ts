/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Force-directed layout for the Memory graph: nodes repel, linked nodes attract, everything
 * is pulled gently to the centre. Pure and deterministic (nodes start on a ring in input
 * order), so the same graph always draws the same way and the layout is testable.
 */

export const GRAPH_WIDTH = 1000;
export const GRAPH_HEIGHT = 700;

export type LayoutNode = { id: string };
export type LayoutEdge = { source: string; target: string; weight: number };
export type Point = { x: number; y: number };

export function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], iterations = 220): Map<string, Point> {
  const n = nodes.length;
  const positions = new Map<string, Point>();
  if (n === 0) return positions;
  const cx = GRAPH_WIDTH / 2;
  const cy = GRAPH_HEIGHT / 2;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const index = new Map<string, number>();
  nodes.forEach((node, i) => {
    index.set(node.id, i);
    const angle = (i / n) * Math.PI * 2;
    const radius = 120 + (i % 7) * 40;
    x[i] = cx + Math.cos(angle) * radius;
    y[i] = cy + Math.sin(angle) * radius;
  });
  const links = edges
    .map((e) => [index.get(e.source), index.get(e.target), e.weight] as const)
    .filter((l): l is readonly [number, number, number] => l[0] !== undefined && l[1] !== undefined);
  const maxWeight = Math.max(1, ...links.map((l) => l[2]));
  const k = Math.sqrt((GRAPH_WIDTH * GRAPH_HEIGHT) / n) * 0.8;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);

  for (let step = 0; step < iterations; step++) {
    const temperature = (1 - step / iterations) * 18 + 0.5;
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = x[i] - x[j];
        let ey = y[i] - y[j];
        let d2 = ex * ex + ey * ey;
        if (d2 < 0.01) {
          ex = (i % 2 ? 1 : -1) * 0.1;
          ey = (j % 2 ? 1 : -1) * 0.1;
          d2 = 0.02;
        }
        if (d2 > k * k * 16) continue;
        const force = (k * k) / d2;
        dx[i] += ex * force;
        dy[i] += ey * force;
        dx[j] -= ex * force;
        dy[j] -= ey * force;
      }
    }
    for (const [a, b, weight] of links) {
      const ex = x[a] - x[b];
      const ey = y[a] - y[b];
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01;
      const force = (d / k) * (0.6 + (weight / maxWeight) * 0.8);
      dx[a] -= (ex / d) * force * d * 0.05;
      dy[a] -= (ey / d) * force * d * 0.05;
      dx[b] += (ex / d) * force * d * 0.05;
      dy[b] += (ey / d) * force * d * 0.05;
    }
    for (let i = 0; i < n; i++) {
      dx[i] += (cx - x[i]) * 0.01;
      dy[i] += (cy - y[i]) * 0.01;
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const move = Math.min(len, temperature);
      x[i] = Math.min(GRAPH_WIDTH - 20, Math.max(20, x[i] + (dx[i] / len) * move));
      y[i] = Math.min(GRAPH_HEIGHT - 20, Math.max(20, y[i] + (dy[i] / len) * move));
    }
  }
  nodes.forEach((node, i) => positions.set(node.id, { x: x[i], y: y[i] }));
  return positions;
}
