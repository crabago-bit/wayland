/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for RightDrawer.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryEntry } from '@/common/types/memory';

// Minimal react-markdown stub - renders children as plain text.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span data-testid='md'>{children}</span>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback ?? _key,
  }),
}));

vi.mock('@icon-park/react', () => ({
  Close: (p: Record<string, unknown>) => <span data-testid='icon-close' {...p} />,
  Copy: (p: Record<string, unknown>) => <span data-testid='icon-copy' {...p} />,
  Edit: (p: Record<string, unknown>) => <span data-testid='icon-edit' {...p} />,
  Inbox: (p: Record<string, unknown>) => <span data-testid='icon-inbox' {...p} />,
}));

import RightDrawer from '@renderer/pages/memory/components/RightDrawer';

const MOCK_ENTRY: MemoryEntry & { body: string } = {
  id: 'entry-001',
  type: 'decision',
  project: 'wayland',
  projectPath: 'brain://wayland',
  summary: 'deploy choice: ship Memory on the brain',
  bodyPreview: 'Body preview...',
  body: 'Full body text explaining the decision in enough detail.',
  tags: ['decision', 'semantic', 'paste'],
  storedAt: Date.UTC(2026, 9, 1, 12, 0, 0),
  sourcePath: 'brain://wayland/entry-001',
  sourceLine: 0,
  referencedBy: 3,
  promotionScore: 75,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RightDrawer', () => {
  it('renders nothing visible when entry is null', () => {
    render(<RightDrawer entry={null} onClose={vi.fn()} />);
    expect(screen.getByTestId('right-drawer')).toBeTruthy();
    expect(screen.queryByTestId('right-drawer-inner')).toBeNull();
  });

  it('shows entry summary in title', () => {
    render(<RightDrawer entry={MOCK_ENTRY} onClose={vi.fn()} />);
    expect(screen.getByTestId('drawer-title').textContent).toContain('deploy choice: ship Memory on the brain');
  });

  it('shows the category label in the badge', () => {
    render(<RightDrawer entry={MOCK_ENTRY} onClose={vi.fn()} />);
    expect(screen.getByTestId('drawer-type-badge').textContent).toContain('Decisions');
  });

  it('shows workspace, category meaning and stored date', () => {
    render(<RightDrawer entry={MOCK_ENTRY} onClose={vi.fn()} />);
    expect(screen.getByTestId('drawer-workspace').textContent).toBe('wayland');
    expect(screen.getByTestId('drawer-project').textContent).toBe('wayland');
    expect(screen.getByTestId('drawer-category').textContent).toContain(
      'Deploy choices, governance, hires, routines and plans.'
    );
    expect(screen.getByTestId('drawer-stored').textContent).toBe(new Date(MOCK_ENTRY.storedAt).toLocaleString());
  });

  it('shows source labels without repeating the category', () => {
    render(<RightDrawer entry={MOCK_ENTRY} onClose={vi.fn()} />);
    const tags = screen.getByTestId('drawer-section-tags');
    expect(tags.textContent).toContain('semantic');
    expect(tags.textContent).toContain('paste');
    expect(tags.textContent).not.toContain('decision');
  });

  it('hides the source section when the only tag is the category', () => {
    render(<RightDrawer entry={{ ...MOCK_ENTRY, tags: ['decision'] }} onClose={vi.fn()} />);
    expect(screen.queryByTestId('drawer-section-tags')).toBeNull();
  });

  it('shows the full body', () => {
    render(<RightDrawer entry={MOCK_ENTRY} onClose={vi.fn()} />);
    expect(screen.getByTestId('drawer-body-text').textContent).toContain(MOCK_ENTRY.body);
  });

  it('has no promote, open-file, score or source-file features', () => {
    render(<RightDrawer entry={MOCK_ENTRY} onClose={vi.fn()} />);
    expect(screen.queryByTestId('drawer-promote-btn')).toBeNull();
    expect(screen.queryByTestId('drawer-open-btn')).toBeNull();
    expect(screen.queryByTestId('drawer-score-wrap')).toBeNull();
    expect(screen.queryByTestId('source-panel')).toBeNull();
    expect(screen.queryByTestId('drawer-source-path')).toBeNull();
  });

  it('clicking close button calls onClose', () => {
    const onClose = vi.fn();
    render(<RightDrawer entry={MOCK_ENTRY} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('drawer-close-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc key calls onClose', () => {
    const onClose = vi.fn();
    render(<RightDrawer entry={MOCK_ENTRY} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('applies drawerOpen class only when entry is set', () => {
    const { rerender } = render(<RightDrawer entry={MOCK_ENTRY} onClose={vi.fn()} />);
    expect(screen.getByTestId('right-drawer').className).toContain('drawerOpen');
    rerender(<RightDrawer entry={null} onClose={vi.fn()} />);
    expect(screen.getByTestId('right-drawer').className).not.toContain('drawerOpen');
  });

  it('Copy passes the body to onCopy', () => {
    const onCopy = vi.fn();
    render(<RightDrawer entry={MOCK_ENTRY} onClose={vi.fn()} onCopy={onCopy} />);
    fireEvent.click(screen.getByTestId('drawer-copy-btn'));
    expect(onCopy).toHaveBeenCalledWith(MOCK_ENTRY.body);
  });

  it('clicking Edit calls onEdit with the full entry', () => {
    const onEdit = vi.fn();
    render(<RightDrawer entry={MOCK_ENTRY} onClose={vi.fn()} onEdit={onEdit} />);
    fireEvent.click(screen.getByTestId('drawer-edit-btn'));
    expect(onEdit).toHaveBeenCalledWith(MOCK_ENTRY);
  });

  it('clicking Archive calls onArchive with the entry (confirm is owned by the host)', () => {
    const onArchive = vi.fn();
    render(<RightDrawer entry={MOCK_ENTRY} onClose={vi.fn()} onArchive={onArchive} />);
    fireEvent.click(screen.getByTestId('drawer-archive-btn'));
    expect(onArchive).toHaveBeenCalledWith(MOCK_ENTRY);
  });
});
