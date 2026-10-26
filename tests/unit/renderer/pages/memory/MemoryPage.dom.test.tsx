/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for the MemoryPage shell.
 *
 * MemoryPage asks `ipcBridge.memory.getBackend` where Memory lives: `brain`
 * renders FullPanelShell, `none` (or any failure to ask) renders the
 * "Connect your brain" card, and a pending answer shows a loading line.
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { bridge } = vi.hoisted(() => ({
  bridge: {
    memory: { getBackend: { invoke: vi.fn<() => Promise<'brain' | 'none'>>() } } as {
      getBackend?: { invoke: (() => Promise<'brain' | 'none'>) | unknown };
    },
  },
}));

vi.mock('@/common', () => ({ ipcBridge: bridge }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('@renderer/pages/memory/state-branches/FullPanelShell', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid='branch-full-panel-shell' data-prop-count={Object.keys(props).length} />
  ),
}));

import MemoryPage from '@renderer/pages/memory/MemoryPage';

const invoke = vi.fn<() => Promise<'brain' | 'none'>>();

beforeEach(() => {
  invoke.mockReset();
  bridge.memory = { getBackend: { invoke } };
});

afterEach(() => {
  cleanup();
});

describe('MemoryPage', () => {
  it('shows a loading line while the backend is pending', () => {
    invoke.mockReturnValue(new Promise(() => {}));
    render(<MemoryPage />);
    expect(screen.getByTestId('memory-loading')).toBeTruthy();
    expect(screen.getByTestId('memory-page')).toBeTruthy();
    expect(screen.queryByTestId('branch-full-panel-shell')).toBeNull();
    expect(screen.queryByTestId('memory-no-brain')).toBeNull();
  });

  it('renders FullPanelShell with no props when the backend is brain', async () => {
    invoke.mockResolvedValue('brain');
    render(<MemoryPage />);
    const shell = await screen.findByTestId('branch-full-panel-shell');
    expect(shell.getAttribute('data-prop-count')).toBe('0');
    expect(screen.queryByTestId('memory-loading')).toBeNull();
    expect(screen.queryByTestId('memory-no-brain')).toBeNull();
    expect(screen.getByTestId('memory-page')).toBeTruthy();
  });

  it('renders the "Connect your brain" card when the backend is none', async () => {
    invoke.mockResolvedValue('none');
    render(<MemoryPage />);
    const card = await screen.findByTestId('memory-no-brain');
    expect(card.textContent).toContain('Connect your brain');
    expect(card.textContent).toContain('No MCP server named brain is configured. Add one in Settings to use Memory.');
    expect(screen.queryByTestId('branch-full-panel-shell')).toBeNull();
  });

  it('treats a rejected getBackend as none', async () => {
    invoke.mockRejectedValue(new Error('ipc down'));
    render(<MemoryPage />);
    expect(await screen.findByTestId('memory-no-brain')).toBeTruthy();
    expect(screen.queryByTestId('branch-full-panel-shell')).toBeNull();
  });

  it('treats a synchronous throw from getBackend as none', async () => {
    invoke.mockImplementation(() => {
      throw new Error('not hydrated');
    });
    render(<MemoryPage />);
    expect(await screen.findByTestId('memory-no-brain')).toBeTruthy();
  });

  it('treats a missing getBackend provider as none', async () => {
    bridge.memory = {};
    render(<MemoryPage />);
    expect(await screen.findByTestId('memory-no-brain')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('treats an unexpected backend value as none', async () => {
    invoke.mockResolvedValue('ijfw' as unknown as 'brain');
    render(<MemoryPage />);
    expect(await screen.findByTestId('memory-no-brain')).toBeTruthy();
  });
});
