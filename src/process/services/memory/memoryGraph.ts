/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The brain stores memories as separate chunks with no links between them, so the Memory
 * graph links two memories when they mention the same specific things: file names, hosts,
 * `code` spans and hyphenated or CamelCase identifiers. A term shared by many memories says
 * nothing, so terms are weighted by rarity and the very common ones are dropped.
 */

import type { MemoryEntry, MemoryGraph, MemoryGraphEdge, MemoryType } from '@/common/types/memory';

type GraphInput = Pick<MemoryEntry, 'id' | 'summary' | 'type' | 'project' | 'referencedBy'> & { body: string };

const MAX_NODES = 500;
const MAX_EDGES_PER_NODE = 5;
const MAX_TERM_LENGTH = 60;
const MIN_TERM_LENGTH = 4;
/** A term in more than this many memories (or share of them) is too common to link on. */
const MAX_TERM_DOCS = 25;
const MAX_TERM_SHARE = 0.03;
const MAX_TERMS_PER_ENTRY = 60;

const PATTERNS: RegExp[] = [
  /`([^`\n]{3,60})`/g,
  /\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|sql|md|sh|py|env|toml|conf|service)\b/gi,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|ai|dev|app|net|org|co)\b/gi,
  /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/gi,
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g,
];

/** Words that look like identifiers but carry no meaning on their own. */
const NOISE = new Set(['e.g', 'i.e', 'well-known', 'long-term', 'built-in', 'non-empty', 'read-only', 'so-called']);
const DATE_LIKE = /^\d{4}-\d{2}(-\d{2})?$|^\d+$|^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function extractTerms(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] ?? match[0]).trim().toLowerCase();
      if (raw.length < MIN_TERM_LENGTH || raw.length > MAX_TERM_LENGTH) continue;
      if (NOISE.has(raw) || DATE_LIKE.test(raw)) continue;
      found.add(raw);
      if (found.size >= MAX_TERMS_PER_ENTRY) return [...found];
    }
  }
  return [...found];
}

/** Every memory's strongest few links (each link appears under both of its ends). */
export function buildMemoryLinks(entries: GraphInput[]): Map<string, MemoryGraphEdge[]> {
  const postings = new Map<string, string[]>();
  for (const entry of entries) {
    const terms = extractTerms(`${entry.summary}\n${entry.body}`);
    for (const term of terms) {
      const list = postings.get(term);
      if (list) list.push(entry.id);
      else postings.set(term, [entry.id]);
    }
  }

  const docLimit = Math.max(MAX_TERM_DOCS, Math.floor(entries.length * MAX_TERM_SHARE));
  const pairs = new Map<string, { source: string; target: string; weight: number; terms: Array<[string, number]> }>();
  for (const [term, ids] of postings) {
    if (ids.length < 2 || ids.length > Math.min(docLimit, MAX_TERM_DOCS)) continue;
    const idf = Math.log(1 + entries.length / ids.length);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [source, target] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        const key = `${source}|${target}`;
        const pair = pairs.get(key) ?? { source, target, weight: 0, terms: [] };
        pair.weight += idf;
        pair.terms.push([term, idf]);
        pairs.set(key, pair);
      }
    }
  }

  // Keep a link when two terms agree, or when one term is rare enough to be specific.
  const strong = [...pairs.values()].filter((p) => p.terms.length >= 2 || postings.get(p.terms[0][0])!.length <= 4);

  // Each memory keeps its strongest few links, so a hub cannot turn the graph into a hairball.
  const perNode = new Map<string, MemoryGraphEdge[]>();
  const toEdge = (p: (typeof strong)[number]): MemoryGraphEdge => ({
    source: p.source,
    target: p.target,
    weight: Math.round(p.weight * 100) / 100,
    terms: p.terms
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t)
      .slice(0, 5),
  });
  for (const pair of strong.sort((a, b) => b.weight - a.weight)) {
    const a = perNode.get(pair.source) ?? [];
    const b = perNode.get(pair.target) ?? [];
    if (a.length >= MAX_EDGES_PER_NODE || b.length >= MAX_EDGES_PER_NODE) continue;
    const edge = toEdge(pair);
    a.push(edge);
    b.push(edge);
    perNode.set(pair.source, a);
    perNode.set(pair.target, b);
  }

  return perNode;
}

export function buildMemoryGraph(entries: GraphInput[], links = buildMemoryLinks(entries)): MemoryGraph {
  const perNode = links;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const degree = new Map<string, number>();
  const edgeSet = new Set<MemoryGraphEdge>();
  for (const list of perNode.values()) for (const e of list) edgeSet.add(e);
  for (const e of edgeSet) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const kept = new Set(
    [...degree.entries()]
      .sort((a, b) => b[1] - a[1] || (byId.get(b[0])?.referencedBy ?? 0) - (byId.get(a[0])?.referencedBy ?? 0))
      .slice(0, MAX_NODES)
      .map(([id]) => id)
  );
  const edges = [...edgeSet].filter((e) => kept.has(e.source) && kept.has(e.target));
  const finalDegree = new Map<string, number>();
  for (const e of edges) {
    finalDegree.set(e.source, (finalDegree.get(e.source) ?? 0) + 1);
    finalDegree.set(e.target, (finalDegree.get(e.target) ?? 0) + 1);
  }
  const nodes = [...kept]
    .filter((id) => (finalDegree.get(id) ?? 0) > 0)
    .map((id) => {
      const e = byId.get(id)!;
      return {
        id,
        summary: e.summary,
        type: e.type as MemoryType,
        project: e.project,
        degree: finalDegree.get(id) ?? 0,
        referencedBy: e.referencedBy,
      };
    });
  return {
    nodes,
    edges,
    totalEntries: entries.length,
    linked: degree.size,
    unlinked: entries.length - degree.size,
  };
}
