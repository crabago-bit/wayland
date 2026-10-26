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

export type SkyNode = { id: string; type: string; degree: number };
export type Sector = { type: string; start: number; end: number; mid: number; count: number };
export type SkyLine = { a: string; b: string };

export const SKY_CX = GRAPH_WIDTH / 2;
export const SKY_CY = GRAPH_HEIGHT / 2;
export const SKY_RADIUS = 300;
const GOLDEN = 0.6180339887;
const SECTOR_GAP = 0.07;
const INNER = 0.1;
const OUTER = 0.95;

/** Deterministic 0..1 from a string, so the same memory always lands on the same spot. */
function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Round star chart: one disc, divided into a wedge per category (wider for bigger categories).
 * Inside its wedge the best-connected memories sit nearest the centre and the rest spiral out,
 * jittered a little so it reads as a sky rather than a diagram. Pure and deterministic.
 */
export function layoutSky(
  nodes: SkyNode[],
  order: readonly string[]
): { positions: Map<string, Point>; sectors: Sector[] } {
  const positions = new Map<string, Point>();
  const groups = new Map<string, SkyNode[]>();
  for (const node of nodes) {
    const list = groups.get(node.type);
    if (list) list.push(node);
    else groups.set(node.type, [node]);
  }
  const present = order.filter((type) => groups.has(type));
  for (const type of groups.keys()) if (!present.includes(type)) present.push(type);

  const weights = present.map((type) => Math.pow(Math.max(groups.get(type)!.length, 8), 0.7));
  const total = weights.reduce((sum, w) => sum + w, 0) || 1;
  const usable = Math.PI * 2 - SECTOR_GAP * present.length;
  const sectors: Sector[] = [];
  let cursor = -Math.PI / 2;
  present.forEach((type, i) => {
    const members = (groups.get(type) ?? []).slice().sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
    const span = (weights[i] / total) * usable;
    const start = cursor + SECTOR_GAP / 2;
    const end = start + span;
    const pad = Math.min(0.05, span * 0.1);
    members.forEach((node, k) => {
      const frac = members.length === 1 ? 0.5 : (k * GOLDEN + hash01(node.id) * 0.25) % 1;
      const angle = start + pad + frac * Math.max(0.0001, span - pad * 2);
      const radial = INNER + (OUTER - INNER) * Math.sqrt((k + 0.5) / members.length);
      const jitter = 1 + (hash01(`${node.id}:r`) - 0.5) * 0.06;
      const r = SKY_RADIUS * Math.min(OUTER, radial * jitter);
      positions.set(node.id, { x: SKY_CX + Math.cos(angle) * r, y: SKY_CY + Math.sin(angle) * r });
    });
    sectors.push({ type, start, end, mid: (start + end) / 2, count: members.length });
    cursor = end + SECTOR_GAP / 2;
  });
  return { positions, sectors };
}

/**
 * The stick figure of each category: a minimum spanning tree over its stars' positions, so every
 * star in a category is joined to its nearest neighbours and the whole group is one connected shape.
 */
export function skyLines(nodes: SkyNode[], positions: Map<string, Point>): SkyLine[] {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    if (!positions.has(node.id)) continue;
    const list = groups.get(node.type);
    if (list) list.push(node.id);
    else groups.set(node.type, [node.id]);
  }
  const lines: SkyLine[] = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const inTree = new Set<string>([ids[0]]);
    const best = new Map<string, { from: string; d: number }>();
    const dist = (a: string, b: string) => {
      const p = positions.get(a)!;
      const q = positions.get(b)!;
      return (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    };
    for (const id of ids.slice(1)) best.set(id, { from: ids[0], d: dist(ids[0], id) });
    while (best.size > 0) {
      let pick = '';
      let pickD = Infinity;
      for (const [id, b] of best) {
        if (b.d < pickD) {
          pick = id;
          pickD = b.d;
        }
      }
      lines.push({ a: best.get(pick)!.from, b: pick });
      best.delete(pick);
      inTree.add(pick);
      for (const [id, b] of best) {
        const d = dist(pick, id);
        if (d < b.d) best.set(id, { from: pick, d });
      }
    }
  }
  return lines;
}

/** A link drawn as a curve bowed toward the centre of the sky, so cross-category links read as arcs. */
export function arcPath(a: Point, b: Point): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const cx = mx + (SKY_CX - mx) * 0.55;
  const cy = my + (SKY_CY - my) * 0.55;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}
