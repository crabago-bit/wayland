/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for EmptyStateHero.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback ?? _key,
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({
    children,
    onClick,
    'data-testid': testId,
  }: React.ComponentProps<'button'> & { 'data-testid'?: string }) => (
    <button data-testid={testId} onClick={onClick}>
      {children}
    </button>
  ),
  Input: ({
    placeholder,
    onChange,
    'data-testid': testId,
  }: {
    placeholder?: string;
    onChange?: (val: string) => void;
    'data-testid'?: string;
  }) => <input placeholder={placeholder} data-testid={testId} onChange={(e) => onChange?.(e.target.value)} />,
}));

import EmptyStateHero from '@renderer/pages/memory/components/EmptyStateHero';

afterEach(() => {
  cleanup();
});

describe('EmptyStateHero', () => {
  it('renders the empty-brain message', () => {
    render(<EmptyStateHero />);
    expect(screen.getByTestId('empty-state-hero')).toBeTruthy();
    expect(screen.getByTestId('empty-hero-headline').textContent).toBe('Your brain has no memories yet.');
    expect(screen.getByTestId('empty-hero-subline').textContent).toBe(
      'Add one with Add, or drop .md/.txt/.json notes anywhere on this page.'
    );
  });

  it('renders no import CTA cards', () => {
    render(<EmptyStateHero />);
    expect(screen.queryByTestId('empty-hero-cards')).toBeNull();
    expect(screen.queryByTestId('empty-import-card-claude-mem')).toBeNull();
  });

  it('forwards search input changes', () => {
    const onSearchChange = vi.fn();
    render(<EmptyStateHero onSearchChange={onSearchChange} />);
    fireEvent.change(screen.getByTestId('empty-hero-search'), { target: { value: 'deploy' } });
    expect(onSearchChange).toHaveBeenCalledWith('deploy');
  });

  it('shows an Add button only when onAdd is given, and calls it', () => {
    const { rerender } = render(<EmptyStateHero />);
    expect(screen.queryByTestId('empty-hero-add')).toBeNull();
    const onAdd = vi.fn();
    rerender(<EmptyStateHero onAdd={onAdd} />);
    fireEvent.click(screen.getByTestId('empty-hero-add'));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
