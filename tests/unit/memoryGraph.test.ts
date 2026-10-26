/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildMemoryGraph, buildMemoryLinks, extractTerms } from '@process/services/memory/memoryGraph';
import { layoutClusters, layoutGraph } from '@/renderer/pages/memory/graphLayout';

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

describe('layoutClusters', () => {
  it('keeps each category in its own cluster and returns one cluster per category present', () => {
    const nodes = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, type: 'decision' })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, type: 'pattern' })),
    ];
    const edges = [{ source: 'd0', target: 'p0', weight: 1 }];
    const { positions, clusters } = layoutClusters(nodes, edges, ['decision', 'preference', 'pattern']);
    expect(clusters.map((c) => c.type)).toEqual(['decision', 'pattern']);
    const dist = (id: string, c: { x: number; y: number }) =>
      Math.hypot(positions.get(id)!.x - c.x, positions.get(id)!.y - c.y);
    for (const node of nodes) {
      const own = clusters.find((c) => c.type === node.type)!;
      const other = clusters.find((c) => c.type !== node.type)!;
      expect(dist(node.id, own)).toBeLessThan(dist(node.id, other));
    }
  });
});

describe('layoutClusters shape', () => {
  it('keeps every star inside its cluster circle', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, type: 'wiki' }));
    const edges = nodes.slice(1).map((n, i) => ({ source: `n${i}`, target: n.id, weight: 1 }));
    const { positions, clusters } = layoutClusters(nodes, edges, ['wiki']);
    const c = clusters[0];
    for (const p of positions.values()) {
      expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(c.radius + 0.001);
    }
  });
});

describe('buildMemoryLinks', () => {
  it('gives each end of a link the same edge', () => {
    const links = buildMemoryLinks([entry('a', 'alpha-one beta-two'), entry('b', 'alpha-one beta-two')]);
    expect(links.get('a')?.[0]).toBe(links.get('b')?.[0]);
  });
});
