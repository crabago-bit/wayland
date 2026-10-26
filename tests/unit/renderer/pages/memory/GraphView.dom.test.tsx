/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryEntry, MemoryGraph } from '@/common/types/memory';
import GraphView from '@/renderer/pages/memory/components/GraphView';
import CardsView from '@/renderer/pages/memory/components/CardsView';
import ConstellationView from '@/renderer/pages/memory/components/ConstellationView';
import RelatedMemories from '@/renderer/pages/memory/components/RelatedMemories';
import { filterGraph, matchingIds } from '@/renderer/pages/memory/graphFilter';

const { mockGetRelated } = vi.hoisted(() => ({ mockGetRelated: vi.fn() }));
vi.mock('@/common/adapter/ipcBridge', () => ({ memory: { getRelated: { invoke: mockGetRelated } } }));

afterEach(cleanup);

const graph: MemoryGraph = {
  nodes: [
    { id: 'a', summary: 'Deploy choice A', type: 'decision', project: 'general', degree: 1, referencedBy: 0 },
    { id: 'b', summary: 'Deploy choice B', type: 'pattern', project: 'general', degree: 1, referencedBy: 0 },
  ],
  edges: [{ source: 'a', target: 'b', weight: 3, terms: ['deploy-webui.sh'] }],
  totalEntries: 10,
  linked: 2,
  unlinked: 8,
};

describe('GraphView', () => {
  it('draws a dot per memory and opens one on click', () => {
    const onSelect = vi.fn();
    render(<GraphView graph={graph} isLoading={false} error={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('memory-graph-node-a'));
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(screen.getByTestId('memory-graph-footer').textContent).toContain('2 of 10');
    expect(screen.getByTestId('memory-graph-footer').textContent).toContain('8 stand alone');
  });

  it('opens a memory from the keyboard', () => {
    const onSelect = vi.fn();
    render(<GraphView graph={graph} isLoading={false} error={null} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByTestId('memory-graph-node-b'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('shows loading, empty and error states', () => {
    const { rerender } = render(<GraphView graph={null} isLoading error={null} />);
    expect(screen.getByTestId('memory-graph-loading')).toBeTruthy();
    rerender(<GraphView graph={{ ...graph, nodes: [], edges: [] }} isLoading={false} error={null} />);
    expect(screen.getByTestId('memory-graph-empty')).toBeTruthy();
    rerender(<GraphView graph={null} isLoading={false} error='boom' />);
    expect(screen.getByTestId('memory-graph-error').textContent).toContain('boom');
  });
});

describe('CardsView', () => {
  const entry = (id: string): MemoryEntry => ({
    id,
    type: 'decision',
    project: 'general',
    projectPath: 'brain://general',
    summary: `Title ${id}`,
    bodyPreview: 'preview text',
    tags: [],
    storedAt: Date.parse('2026-10-01'),
    sourcePath: `brain://general/${id}`,
    sourceLine: 0,
    referencedBy: 0,
    promotionScore: 0,
  });

  it('renders a card per memory and selects on click', () => {
    const onSelect = vi.fn();
    render(<CardsView entries={[entry('x'), entry('y')]} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('memory-card-y'));
    expect(onSelect).toHaveBeenCalledWith('y');
    expect(screen.getByText('Title x')).toBeTruthy();
  });

  it('shows an empty state', () => {
    render(<CardsView entries={[]} />);
    expect(screen.getByTestId('memory-cards-empty')).toBeTruthy();
  });
});

describe('CardsView grouping', () => {
  const make = (id: string, type: MemoryEntry['type']): MemoryEntry => ({
    id,
    type,
    project: 'general',
    projectPath: 'brain://general',
    summary: `T ${id}`,
    bodyPreview: '',
    tags: [],
    storedAt: 0,
    sourcePath: '',
    sourceLine: 0,
    referencedBy: 0,
    promotionScore: 0,
  });

  it('groups cards under a header per category, in category order', () => {
    render(<CardsView entries={[make('p', 'pattern'), make('d', 'decision'), make('p2', 'pattern')]} />);
    const groups = screen.getAllByTestId(/memory-cards-group-/).map((el) => el.getAttribute('data-testid'));
    expect(groups).toEqual(['memory-cards-group-decision', 'memory-cards-group-pattern']);
    expect(screen.getByTestId('memory-cards-group-pattern').textContent).toContain('2');
  });
});

describe('ConstellationView', () => {
  it('draws a star per memory in a labelled cluster and opens one on click', () => {
    const onSelect = vi.fn();
    render(<ConstellationView graph={graph} isLoading={false} error={null} onSelect={onSelect} />);
    expect(screen.getByTestId('memory-constellation-cluster-decision').textContent).toContain('Decisions');
    expect(screen.getByTestId('memory-constellation-cluster-pattern')).toBeTruthy();
    fireEvent.click(screen.getByTestId('memory-constellation-star-b'));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('shows loading, empty and error states', () => {
    const { rerender } = render(<ConstellationView graph={null} isLoading error={null} />);
    expect(screen.getByTestId('memory-constellation-loading')).toBeTruthy();
    rerender(<ConstellationView graph={{ ...graph, nodes: [], edges: [] }} isLoading={false} error={null} />);
    expect(screen.getByTestId('memory-constellation-empty')).toBeTruthy();
    rerender(<ConstellationView graph={null} isLoading={false} error='nope' />);
    expect(screen.getByTestId('memory-constellation-error').textContent).toContain('nope');
  });
});

describe('graph filters', () => {
  it('drops memories below the link minimum and the lines to them', () => {
    const wide: MemoryGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: 'c', summary: 'Loner', type: 'wiki', project: 'general', degree: 1, referencedBy: 0 },
      ],
    };
    const filtered = filterGraph(
      { ...wide, nodes: wide.nodes.map((n) => (n.id === 'a' ? { ...n, degree: 3 } : n)) },
      2
    );
    expect(filtered?.nodes.map((n) => n.id)).toEqual(['a']);
    expect(filtered?.edges).toHaveLength(0);
    expect(filterGraph(graph, 1)).toBe(graph);
  });

  it('matches titles case-insensitively and ignores one-letter searches', () => {
    expect(matchingIds(graph, 'choice a')).toEqual(new Set(['a']));
    expect(matchingIds(graph, 'd')).toBeNull();
    expect(matchingIds(graph, '')).toBeNull();
  });
});

describe('RelatedMemories', () => {
  it('lists related memories and opens one', async () => {
    mockGetRelated.mockResolvedValue([
      { id: 'r1', summary: 'Related one', type: 'pattern', weight: 4, terms: ['deploy-webui.sh', 'pm2'] },
    ]);
    const onOpen = vi.fn();
    render(<RelatedMemories entryId='a' onOpen={onOpen} label='Related' />);
    fireEvent.click(await screen.findByTestId('related-r1'));
    expect(onOpen).toHaveBeenCalledWith('r1');
    expect(mockGetRelated).toHaveBeenCalledWith({ id: 'a' });
  });

  it('renders nothing when nothing is related', async () => {
    mockGetRelated.mockResolvedValue([]);
    const { container } = render(<RelatedMemories entryId='a' onOpen={() => undefined} label='Related' />);
    await vi.waitFor(() => expect(mockGetRelated).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
