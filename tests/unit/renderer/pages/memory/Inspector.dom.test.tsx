/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for the Inspector component.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback ?? _key,
  }),
}));

vi.mock('@icon-park/react', () => ({
  Close: (props: Record<string, unknown>) => <span data-testid='icon-close' {...props} />,
  Copy: (props: Record<string, unknown>) => <span data-testid='icon-copy' {...props} />,
  Edit: (props: Record<string, unknown>) => <span data-testid='icon-edit' {...props} />,
  Inbox: (props: Record<string, unknown>) => <span data-testid='icon-inbox' {...props} />,
  FileCode: (props: Record<string, unknown>) => <span data-testid='icon-file-code' {...props} />,
}));

import Inspector from '@renderer/pages/memory/components/Inspector';
import type { InspectorProps } from '@renderer/pages/memory/components/Inspector';
import type { MemoryEntry } from '@/common/types/memory';

const BASE_ENTRY: MemoryEntry & { body: string } = {
  id: 'mem-001',
  type: 'preference',
  project: 'general',
  projectPath: 'brain://general',
  summary: 'hard rule: never use navy in the brand',
  bodyPreview: 'never use navy',
  body: 'Brand colours are black and gold. Never use navy anywhere.',
  tags: ['preference', 'paste'],
  storedAt: Date.now() - 3600_000,
  sourcePath: 'brain://general/mem-001',
  sourceLine: 0,
  referencedBy: 12,
  promotionScore: 75,
};

const defaultProps = (overrides: Partial<InspectorProps> = {}): InspectorProps => ({
  entry: BASE_ENTRY,
  onClose: vi.fn(),
  onCopy: vi.fn(),
  onEdit: vi.fn(),
  onArchive: vi.fn(),
  ...overrides,
});

afterEach(() => {
  cleanup();
});

describe('Inspector', () => {
  it('renders the empty state when entry is null', () => {
    render(<Inspector {...defaultProps({ entry: null })} />);
    expect(screen.getByTestId('inspector-empty')).toBeTruthy();
  });

  it('renders title, workspace, category, source and body', () => {
    render(<Inspector {...defaultProps()} />);
    expect(screen.getByTestId('inspector-title').textContent).toBe(BASE_ENTRY.summary);
    expect(screen.getByTestId('inspector-workspace').textContent).toBe('general');
    expect(screen.getByTestId('inspector-type-badge').textContent).toContain('Preferences');
    expect(screen.getByTestId('inspector-section-category').textContent).toContain(
      'Hard rules and standing preferences.'
    );
    expect(screen.getByTestId('inspector-section-tags').textContent).toBe('Sourcepaste');
    expect(screen.getByTestId('inspector-body').textContent).toBe(BASE_ENTRY.body);
  });

  it('has no promote, open-file or score UI', () => {
    render(<Inspector {...defaultProps()} />);
    expect(screen.queryByTestId('inspector-promote-btn')).toBeNull();
    expect(screen.queryByTestId('inspector-open-btn')).toBeNull();
    expect(screen.queryByTestId('inspector-score-wrap')).toBeNull();
    expect(screen.queryByTestId('inspector-source-path')).toBeNull();
  });

  it('× and Esc call onClose', () => {
    const onClose = vi.fn();
    render(<Inspector {...defaultProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('inspector-close'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Copy, Edit and Archive call their callbacks', () => {
    const props = defaultProps();
    render(<Inspector {...props} />);
    fireEvent.click(screen.getByTestId('inspector-copy-btn'));
    fireEvent.click(screen.getByTestId('inspector-edit-btn'));
    fireEvent.click(screen.getByTestId('inspector-archive-btn'));
    expect(props.onCopy).toHaveBeenCalledWith(BASE_ENTRY.body);
    expect(props.onEdit).toHaveBeenCalledWith(BASE_ENTRY);
    expect(props.onArchive).toHaveBeenCalledWith(BASE_ENTRY);
  });
});
