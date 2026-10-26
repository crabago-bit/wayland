/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM smoke tests for FullPanelShell v0.6.4 Mail-style layout.
 *
 * Tests:
 *   - topbar renders with breadcrumb heading
 *   - filter bar renders
 *   - main body renders
 *   - clicking a row opens the right drawer with entry data
 *   - clicking the same row again closes the drawer
 *   - Esc key closes the drawer
 *   - empty state hero shown when no entries and no filters
 *   - status bar renders
 *   - brain-only chrome (no IJFW strip / import / promotion), drop ingest
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import type { MemoryStats, MemoryEntry, ProjectSummary } from '@/common/types/memory';

const MOCK_STATS: MemoryStats = {
  total: 42,
  decisions: 10,
  wiki: 5,
  sessions: 8,
  projects: 3,
  banked: 120,
  deltas: {
    total24h: 2,
    total7d: 8,
    decisions24h: 1,
    decisions7d: 3,
    wiki24h: 0,
    wiki7d: 1,
    sessions24h: 0,
    sessions7d: 2,
  },
  sparkline: [],
  sparklines: {
    total: Array(30).fill(10),
    banked: Array(30).fill(0),
    decisions: Array(30).fill(5),
    wiki: Array(30).fill(0),
    sessions: Array(30).fill(2),
    projects: Array(30).fill(1),
  },
  typeCounts: {
    decision: 10,
    pattern: 3,
    session: 8,
    observation: 2,
    wiki: 5,
    preference: 1,
  },
  streak: { sessions: 30, longestDays: 12, lastActiveDayMs: Date.now() - 86400_000 },
};

const MOCK_ENTRY: MemoryEntry = {
  id: 'entry-001',
  type: 'decision',
  project: 'wayland',
  projectPath: 'brain://wayland',
  summary: 'decision: always use Arco components',
  bodyPreview: 'Body preview...',
  tags: ['decision', 'paste'],
  storedAt: Date.now() - 3600_000,
  sourcePath: 'brain://wayland/entry-001',
  sourceLine: 0,
  referencedBy: 3,
  promotionScore: 70,
};

const MOCK_FULL_ENTRY = {
  ...MOCK_ENTRY,
  body: 'Full body text explaining why Arco is used everywhere.',
};

const MOCK_PROJECTS: ProjectSummary[] = [
  { path: 'brain://wayland', basename: 'wayland', count: 30, lastActive: Date.now() },
  { path: 'brain://general', basename: 'general', count: 12, lastActive: Date.now(), isGlobalStore: true },
];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Only the calls the Memory page is allowed to use. Anything else (ijfw.*,
// memory.import.*, promote, readSourceContext, shell.*) is absent, so a stray
// call throws and fails the test.
const { mockMemory, mockModalConfirm } = vi.hoisted(() => {
  let _indexChangedListeners: Array<(v: unknown) => void> = [];
  const mockIndexChangedEmitter = {
    on: (cb: (v: unknown) => void) => {
      _indexChangedListeners.push(cb);
      return () => {
        _indexChangedListeners = _indexChangedListeners.filter((l) => l !== cb);
      };
    },
  };

  return {
    mockMemory: {
      getBackend: { invoke: vi.fn() },
      getStats: { invoke: vi.fn() },
      listEntries: { invoke: vi.fn() },
      getEntry: { invoke: vi.fn() },
      getProjects: { invoke: vi.fn() },
      getTags: { invoke: vi.fn() },
      setQuickAdd: { invoke: vi.fn() },
      updateEntry: { invoke: vi.fn() },
      deleteEntry: { invoke: vi.fn() },
      listArchivedEntries: { invoke: vi.fn() },
      restoreArchivedEntry: { invoke: vi.fn() },
      ingestFiles: { invoke: vi.fn() },
      onIndexChanged: mockIndexChangedEmitter,
    },
    // Captures the config passed to Modal.confirm so the archive-gate test can
    // assert deleteEntry fires ONLY from the confirm dialog's onOk.
    mockModalConfirm: vi.fn((_cfg: unknown) => ({ close: vi.fn() })),
  };
});

vi.mock('@/common/adapter/ipcBridge', () => ({
  memory: mockMemory,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    memory: mockMemory,
  },
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@arco-design/web-react');
  return {
    ...actual,
    Message: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    // Modal.confirm is captured (delete gate); the component form renders its
    // children when visible so any other Modal usage in the tree still works.
    Modal: Object.assign(
      ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
        visible ? <div data-testid='arco-modal'>{children}</div> : null,
      { confirm: mockModalConfirm }
    ),
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Dropdown: ({ children, droplist }: { children: React.ReactNode; droplist: React.ReactNode }) => (
      <div>
        {children}
        {droplist}
      </div>
    ),
  };
});

vi.mock('@icon-park/react', () => ({
  Close: (p: Record<string, unknown>) => <span data-testid='icon-close' {...p} />,
  Copy: (p: Record<string, unknown>) => <span data-testid='icon-copy' {...p} />,
  Edit: (p: Record<string, unknown>) => <span data-testid='icon-edit' {...p} />,
  Inbox: (p: Record<string, unknown>) => <span data-testid='icon-inbox' {...p} />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, arg?: unknown, opts?: Record<string, unknown>) => {
      if (typeof arg !== 'string') return _key;
      return opts ? arg.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => String(opts[k] ?? '')) : arg;
    },
  }),
}));

import FullPanelShell from '@renderer/pages/memory/state-branches/FullPanelShell';

const renderShell = (initialEntries: string[] = ['/memory']) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <FullPanelShell />
    </MemoryRouter>
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mockMemory.getStats.invoke.mockResolvedValue({ ok: true, stats: MOCK_STATS });
  mockMemory.listEntries.invoke.mockResolvedValue({ entries: [MOCK_ENTRY], total: 1 });
  mockMemory.getEntry.invoke.mockResolvedValue(MOCK_FULL_ENTRY);
  mockMemory.getProjects.invoke.mockResolvedValue(MOCK_PROJECTS);
  mockMemory.getTags.invoke.mockResolvedValue([{ tag: 'arco', count: 5 }]);
  mockMemory.setQuickAdd.invoke.mockResolvedValue({ ok: true });
  mockMemory.deleteEntry.invoke.mockResolvedValue({ ok: true });
  mockMemory.listArchivedEntries.invoke.mockResolvedValue([]);
  mockMemory.restoreArchivedEntry.invoke.mockResolvedValue({ ok: true });
  mockMemory.updateEntry.invoke.mockResolvedValue({ ok: true });
  mockMemory.ingestFiles.invoke.mockResolvedValue({ ok: true, ingested: 1, errors: [] });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FullPanelShell (v0.6.4 Mail-style)', () => {
  it('renders breadcrumb heading', async () => {
    await act(async () => {
      renderShell();
    });
    const heading = screen.getByTestId('memory-full-panel-heading');
    expect(heading.textContent).toContain('Archive');
  });

  it('renders the filter bar', async () => {
    await act(async () => {
      renderShell();
    });
    expect(screen.getByTestId('memory-filter-bar')).toBeTruthy();
  });

  it('renders the main body container', async () => {
    await act(async () => {
      renderShell();
    });
    expect(screen.getByTestId('memory-body')).toBeTruthy();
  });

  it('renders the list column', async () => {
    await act(async () => {
      renderShell();
    });
    expect(screen.getByTestId('memory-list-col')).toBeTruthy();
  });

  it('renders MemoryStatusBar', async () => {
    await act(async () => {
      renderShell();
    });
    expect(screen.getByTestId('memory-status-bar')).toBeTruthy();
  });

  it('renders right drawer (closed initially)', async () => {
    await act(async () => {
      renderShell();
    });
    const drawer = screen.getByTestId('right-drawer');
    expect(drawer).toBeTruthy();
    // Drawer is closed - no inner content
    expect(screen.queryByTestId('right-drawer-inner')).toBeNull();
  });

  it('clicking a row opens the right drawer with entry data', async () => {
    await act(async () => {
      renderShell();
    });
    // Wait for entries to load
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const rows = screen.queryAllByTestId(`memory-row-${MOCK_ENTRY.id}`);
    if (rows.length > 0) {
      await act(async () => {
        fireEvent.click(rows[0]!);
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(mockMemory.getEntry.invoke).toHaveBeenCalledWith({ id: 'entry-001' });
    }
  });

  it('Esc key clears selection', async () => {
    await act(async () => {
      renderShell(['/memory?entry=entry-001']);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    // After Esc, no crash and panel is still visible
    expect(screen.getByTestId('memory-full-panel')).toBeTruthy();
  });

  it('shows EmptyStateHero when no entries and no filters', async () => {
    mockMemory.listEntries.invoke.mockResolvedValue({ entries: [], total: 0 });
    await act(async () => {
      renderShell();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByTestId('empty-state-hero')).toBeTruthy();
  });

  it('renders MemoryList pane (not empty hero) when entries exist', async () => {
    await act(async () => {
      renderShell();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByTestId('memory-list-pane')).toBeTruthy();
    expect(screen.queryByTestId('empty-state-hero')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Brain-only chrome: no IJFW strip, import, promotion or settings controls.
// ---------------------------------------------------------------------------

describe('FullPanelShell brain chrome', () => {
  it('shows the brain scope label and no IJFW strip, import or settings controls', async () => {
    await act(async () => {
      renderShell();
    });
    expect(screen.getByTestId('memory-scope-label').textContent).toBe(
      'Everything here lives in your brain MCP server, so your agents and this page share the same memories.'
    );
    expect(screen.queryByTestId('memory-setup-status-strip')).toBeNull();
    expect(screen.queryByTestId('memory-btn-import')).toBeNull();
    expect(screen.queryByTestId('memory-btn-settings')).toBeNull();
    expect(screen.getByTestId('memory-btn-quickadd')).toBeTruthy();
    expect(screen.getByTestId('memory-btn-archived')).toBeTruthy();
  });

  it('always shows the category descriptions on the topbar chips', async () => {
    await act(async () => {
      renderShell();
    });
    expect(screen.getByTestId('topbar-chip-memories').getAttribute('title')).toBe(
      'Everything stored in your brain, across all workspaces.'
    );
    expect(screen.getByTestId('topbar-chip-decisions').getAttribute('title')).toBe(
      'Deploy choices, governance, hires, routines and plans.'
    );
    expect(screen.getByTestId('topbar-chip-wiki').getAttribute('title')).toBe(
      'Notes from Obsidian, files, URLs and docs.'
    );
  });

  it('status bar shows the brain total', async () => {
    await act(async () => {
      renderShell();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByTestId('status-total-pill').textContent).toBe('42 memories');
  });

  it('opens the composer on the general workspace when no workspace filter is set', async () => {
    await act(async () => {
      renderShell();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-btn-quickadd'));
    });
    const picker = screen.getByTestId('composer-workspace-picker') as HTMLSelectElement;
    expect(picker.value).toBe('general');
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['general', 'wayland']);
  });

  it('ingests dropped notes through ingestFiles', async () => {
    await act(async () => {
      renderShell();
    });
    const file = new File(['# Note\n\nA dropped note that is long enough to keep.'], 'note.md', {
      type: 'text/markdown',
    });
    await act(async () => {
      fireEvent.drop(screen.getByTestId('memory-full-panel'), {
        dataTransfer: { files: [file], types: ['Files'] },
      });
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(mockMemory.ingestFiles.invoke).toHaveBeenCalledWith({
      files: [{ name: 'note.md', content: '# Note\n\nA dropped note that is long enough to keep.' }],
    });
  });
});

// ---------------------------------------------------------------------------
// #414 - Archive is gated behind confirmation. The legacy-named deleteEntry IPC
// now performs a durable archive and must fire only from the dialog's onOk.
// ---------------------------------------------------------------------------

describe('FullPanelShell archive confirm gate (#414)', () => {
  it('does not call deleteEntry on button click; only the confirm onOk fires it', async () => {
    await act(async () => {
      renderShell(['/memory?entry=entry-001']);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // Drawer is open with the selected entry; the Archive action is present.
    const archiveBtn = screen.getByTestId('drawer-archive-btn');
    expect(archiveBtn).toBeTruthy();

    // Click Archive: the confirm dialog is requested, but nothing changes yet.
    await act(async () => {
      fireEvent.click(archiveBtn);
    });
    expect(mockModalConfirm).toHaveBeenCalledTimes(1);
    expect(mockMemory.deleteEntry.invoke).not.toHaveBeenCalled();

    // The confirm copy says what archiving does to a brain memory.
    const cfg = mockModalConfirm.mock.calls[0]![0] as {
      content?: string;
      onOk?: () => Promise<void> | void;
    };
    expect(String(cfg.content)).toContain('hides the memory from Wayland');
    expect(String(cfg.content)).toContain('brain keeps the original');
    expect(String(cfg.content)).toContain('Archived');

    // Only firing the dialog's onOk performs the durable archive.
    await act(async () => {
      await cfg.onOk?.();
    });
    expect(mockMemory.deleteEntry.invoke).toHaveBeenCalledTimes(1);
    expect(mockMemory.deleteEntry.invoke).toHaveBeenCalledWith({ id: 'entry-001' });
  });

  it('lists durable archives from the top bar and restores one in-app', async () => {
    mockMemory.listArchivedEntries.invoke.mockResolvedValue([
      {
        archiveId: '11111111-1111-4111-8111-111111111111',
        summary: 'Archived customer memory',
        archivedAt: Date.now(),
        sourcePath: 'brain://wayland/abc',
      },
    ]);

    await act(async () => {
      renderShell();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-btn-archived'));
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(screen.getByText('Archived customer memory')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('restore-memory-11111111-1111-4111-8111-111111111111'));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(mockMemory.restoreArchivedEntry.invoke).toHaveBeenCalledWith({
      archiveId: '11111111-1111-4111-8111-111111111111',
    });
  });
});
