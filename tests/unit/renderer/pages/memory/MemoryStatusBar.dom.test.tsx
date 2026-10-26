/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for MemoryStatusBar.
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, opts?: Record<string, unknown>) => {
      if (!opts) return fallback ?? _key;
      return (fallback ?? _key).replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => String(opts[k] ?? `{{${k}}}`));
    },
  }),
}));

import MemoryStatusBar from '@renderer/pages/memory/components/MemoryStatusBar';

afterEach(() => {
  cleanup();
});

describe('MemoryStatusBar', () => {
  it('renders "Brain live" when brainLive is true', () => {
    render(<MemoryStatusBar brainLive total={3} />);
    expect(screen.getByTestId('status-brain-pill').textContent).toContain('Brain live');
  });

  it('renders "Brain offline" when brainLive is false', () => {
    render(<MemoryStatusBar brainLive={false} total={0} />);
    expect(screen.getByTestId('status-brain-pill').textContent).toContain('Brain offline');
  });

  it('shows the total memory count', () => {
    render(<MemoryStatusBar brainLive total={1234} />);
    expect(screen.getByTestId('status-total-pill').textContent).toBe(`${(1234).toLocaleString()} memories`);
  });

  it('has no drop-folder, CLI or dream pills', () => {
    render(<MemoryStatusBar brainLive total={1} />);
    expect(screen.queryByTestId('status-drop-folder-chip')).toBeNull();
    expect(screen.queryByTestId('status-cli-pill')).toBeNull();
    expect(screen.queryByTestId('status-dream-pill')).toBeNull();
  });

  it('renders keyboard hints (K9 fix)', () => {
    render(<MemoryStatusBar brainLive total={1} />);
    expect(screen.getByTestId('status-kbd-search')).toBeTruthy();
    expect(screen.getByTestId('status-kbd-nav-j')).toBeTruthy();
    expect(screen.getByTestId('status-kbd-nav-k')).toBeTruthy();
    expect(screen.getByTestId('status-kbd-close')).toBeTruthy();
  });
});
