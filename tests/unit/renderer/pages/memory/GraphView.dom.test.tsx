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

vi.mock('react-virtuoso', () => ({
  VirtuosoGrid: ({ totalCount, itemContent }: { totalCount: number; itemContent: (i: number) => React.ReactNode }) => (
    <div>
      {Array.from({ length: totalCount }, (_, i) => (
        <div key={i}>{itemContent(i)}</div>
      ))}
    </div>
  ),
}));

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
