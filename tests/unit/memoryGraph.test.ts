/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildMemoryGraph, buildMemoryLinks, extractTerms } from '@process/services/memory/memoryGraph';
import {
  SKY_CX,
  SKY_CY,
  SKY_RADIUS,
  arcPath,
  layoutGraph,
  layoutSky,
  skyLines,
} from '@/renderer/pages/memory/graphLayout';

const entry = (id: string, body: string, type: 'decision' | 'pattern' = 'decision') => ({
  id,
  summary: `title ${id}`,
  body,
  type,
  project: 'general',
  referencedBy: 0,
});

describe('extractTerms', () => {
  it('finds files, hosts, code spans and identifiers, and drops dates and noise', () => {
    const terms = extractTerms(
      'Edited deploy-webui.sh and `brainMemoryService` on os.warriorhi.com, MemoryBackend 2026-10-25 e.g. long-term'
    );
    expect(terms).toEqual(expect.arrayContaining(['deploy-webui.sh', 'brainmemoryservice', 'os.warriorhi.com']));
    expect(terms).toContain('memorybackend');
    expect(terms).not.toContain('2026-10-25');
    expect(terms).not.toContain('long-term');
  });
});

describe('buildMemoryGraph', () => {
  it('links memories that share specific terms and leaves unrelated ones out', () => {
    const graph = buildMemoryGraph([
      entry('a', 'fix in deploy-webui.sh and pm2-restart.sh'),
      entry('b', 'again deploy-webui.sh with pm2-restart.sh'),
      entry('c', 'nothing in common here at all'),
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].terms).toEqual(expect.arrayContaining(['deploy-webui.sh', 'pm2-restart.sh']));
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(graph).toMatchObject({ totalEntries: 3, linked: 2, unlinked: 1 });
  });

  it('does not link on a term that appears everywhere', () => {
    const many = Array.from({ length: 40 }, (_, i) => entry(`m${i}`, 'uses common-thing in the usual way'));
    expect(buildMemoryGraph(many).edges).toHaveLength(0);
  });

  it('does not link on a single shared term unless it is rare', () => {
    const graph = buildMemoryGraph([
      entry('a', 'one shared-thing here'),
      entry('b', 'one shared-thing there'),
      entry('c', 'one shared-thing too'),
      entry('d', 'one shared-thing also'),
      entry('e', 'one shared-thing again'),
    ]);
    expect(graph.edges).toHaveLength(0);
  });

  it('caps each memory at a handful of links', () => {
    const hub = entry('hub', 'alpha-one beta-two gamma-three');
    const spokes = Array.from({ length: 12 }, (_, i) =>
      entry(`s${i}`, `alpha-one beta-two gamma-three unique-${i}-term`)
    );
    const graph = buildMemoryGraph([hub, ...spokes]);
    const hubDegree = graph.nodes.find((n) => n.id === 'hub')?.degree ?? 0;
    expect(hubDegree).toBeLessThanOrEqual(5);
  });
});

describe('layoutGraph', () => {
  it('places every node inside the canvas, deterministically', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
    const edges = nodes.slice(1).map((n) => ({ source: 'n0', target: n.id, weight: 1 }));
    const a = layoutGraph(nodes, edges, 60);
    const b = layoutGraph(nodes, edges, 60);
    expect(a.size).toBe(12);
    for (const [id, p] of a) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1000);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(700);
      expect(b.get(id)).toEqual(p);
    }
  });

  it('returns nothing for an empty graph', () => {
    expect(layoutGraph([], []).size).toBe(0);
  });
});

describe('layoutSky', () => {
  const nodes = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, type: 'decision', degree: 30 - i })),
    ...Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, type: 'pattern', degree: 12 - i })),
    { id: 'w0', type: 'wiki', degree: 1 },
  ];
  const order = ['decision', 'preference', 'pattern', 'session', 'wiki', 'observation'];

  it('keeps every star inside the round chart and inside its own wedge', () => {
    const { positions, sectors } = layoutSky(nodes, order);
    expect(sectors.map((s) => s.type)).toEqual(['decision', 'pattern', 'wiki']);
    for (const node of nodes) {
      const p = positions.get(node.id)!;
      const r = Math.hypot(p.x - SKY_CX, p.y - SKY_CY);
      expect(r).toBeLessThanOrEqual(SKY_RADIUS + 0.001);
      const sector = sectors.find((s) => s.type === node.type)!;
      let angle = Math.atan2(p.y - SKY_CY, p.x - SKY_CX);
      while (angle < sector.start) angle += Math.PI * 2;
      expect(angle).toBeGreaterThanOrEqual(sector.start - 1e-6);
      expect(angle).toBeLessThanOrEqual(sector.end + 1e-6);
    }
  });

  it('puts the best-connected memory of a category nearest the centre, deterministically', () => {
    const a = layoutSky(nodes, order);
    const b = layoutSky(nodes, order);
    const radius = (id: string) => {
      const p = a.positions.get(id)!;
      return Math.hypot(p.x - SKY_CX, p.y - SKY_CY);
    };
    expect(radius('d0')).toBeLessThan(radius('d29'));
    for (const [id, p] of a.positions) expect(b.positions.get(id)).toEqual(p);
  });

  it('gives wedges that do not overlap', () => {
    const { sectors } = layoutSky(nodes, order);
    for (let i = 1; i < sectors.length; i++) expect(sectors[i].start).toBeGreaterThan(sectors[i - 1].end);
  });
});

describe('skyLines', () => {
  it('joins every category into one connected figure', () => {
    const nodes = [
      ...Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, type: 'decision', degree: i })),
      ...Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, type: 'pattern', degree: i })),
      { id: 'w0', type: 'wiki', degree: 1 },
    ];
    const { positions } = layoutSky(nodes, ['decision', 'pattern', 'wiki']);
    const lines = skyLines(nodes, positions);
    // A tree over n stars has n - 1 lines; a lone star has none.
    expect(lines).toHaveLength(24 + 8);
    const reach = (type: string) => {
      const ids = nodes.filter((n) => n.type === type).map((n) => n.id);
      const seen = new Set([ids[0]]);
      for (let pass = 0; pass < ids.length; pass++) {
        for (const l of lines) {
          if (seen.has(l.a) !== seen.has(l.b) && ids.includes(l.a) && ids.includes(l.b)) {
            seen.add(l.a);
            seen.add(l.b);
          }
        }
      }
      return seen.size;
    };
    expect(reach('decision')).toBe(25);
    expect(reach('pattern')).toBe(9);
  });
});

describe('arcPath', () => {
  it('bows a link toward the centre of the sky', () => {
    const d = arcPath({ x: 200, y: 100 }, { x: 800, y: 100 });
    const control = d.match(/Q ([\d.]+) ([\d.]+)/)!;
    expect(Number(control[2])).toBeGreaterThan(100);
  });
});

describe('buildMemoryLinks', () => {
  it('gives each end of a link the same edge', () => {
    const links = buildMemoryLinks([entry('a', 'alpha-one beta-two'), entry('b', 'alpha-one beta-two')]);
    expect(links.get('a')?.[0]).toBe(links.get('b')?.[0]);
  });
});
