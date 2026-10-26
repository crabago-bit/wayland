/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FullPanelShell - v0.6.4 Mail-style Memory Archive chrome.
 *
 * Layout (CSS Grid, 4 rows):
 *   1. topbar    - 56px: breadcrumb + TopbarChips + StreakPill + Archived + Add
 *   2. filterbar - 48px: search input + ProjectDropdown + TimeDropdown + TypeDropdown + result count
 *   3. main      - 1fr: horizontal flex { MemoryList (1fr) | RightDrawer (480px push-content) }
 *   4. statusbar - 28px: MemoryStatusBar
 *
 * Keyboard:
 *   ⌘K / "/" - focus search
 *   Esc       - close drawer (handled by useSelectedEntry + RightDrawer)
 *   J / K     - navigate rows via MemoryList keyboard handler
 *   ⌘N        - open quick-add
 *
 * Empty states:
 *   - Zero entries + no active filters → EmptyStateHero fills main area
 *   - Zero entries + filters active   → in-list zero state (K6)
 *
 * Drawer: push-content via CSS transition on width (NOT overlay).
 * List column margin-right transitions in sync with drawer opening.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Message, Modal } from '@arco-design/web-react';
import type { RefInputType } from '@arco-design/web-react/es/Input/interface';
import { Archive, ArchiveRestore, Search, Plus } from 'lucide-react';
import { formatModifierShortcut } from '@/renderer/utils/platform';
import { memory as memoryBridge } from '@/common/adapter/ipcBridge';
import { ErrorBoundary } from '@/renderer/components/ErrorBoundary';
import type { ListFilter, MemoryEntry, MemoryType } from '@/common/types/memory';
import { useTranslation } from 'react-i18next';
import { useInRouterContext } from 'react-router-dom';
import MemoryList from '../components/MemoryList';
import RightDrawer from '../components/RightDrawer';
import TopbarChips from '../components/TopbarChips';
import UrlTypeSync from '../components/UrlTypeSync';
import StreakPill from '../components/StreakPill';
import ProjectDropdown from '../components/ProjectDropdown';
import TimeDropdown from '../components/TimeDropdown';
import TypeDropdown from '../components/TypeDropdown';
import EmptyStateHero from '../components/EmptyStateHero';
import MemoryStatusBar from '../components/MemoryStatusBar';
import ComposerModal from '../components/ComposerModal';
import EntryEditorModal from '../components/EntryEditorModal';
import ArchivedMemoryModal from '../components/ArchivedMemoryModal';
import { useMemoryIndex } from '../hooks/useMemoryIndex';
import { useSelectedEntry } from '../hooks/useSelectedEntry';
import type { TimeWindow } from '../components/TimeDropdown';
import { GLOBAL_WORKSPACE } from '../categories';
import styles from './FullPanelShell.module.css';

// ---------------------------------------------------------------------------
// Helpers - map TimeWindow → ListFilter.timeWindow
// ---------------------------------------------------------------------------

function timeWindowToFilter(tw: TimeWindow): ListFilter['timeWindow'] {
  if (typeof tw === 'object') return 'all'; // custom range - server doesn't support yet
  if (tw === 'today') return 'today';
  if (tw === '7d') return '7d';
  if (tw === '30d') return '30d';
  return 'all';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FILTER: ListFilter = {
  project: 'all',
  types: [],
  tags: [],
  timeWindow: 'all',
  search: '',
  sort: 'recent',
  offset: 0,
  limit: 50,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const FullPanelShell: React.FC = () => {
  const { t } = useTranslation('memory');

  /** What each topbar chip counts. */
  const chipDescriptions = {
    memories: t('archive.chip.memoriesDescription', 'Everything stored in your brain, across all workspaces.'),
    decisions: t('archive.chip.decisionsDescription', 'Deploy choices, governance, hires, routines and plans.'),
    wiki: t('archive.chip.wikiDescription', 'Notes from Obsidian, files, URLs and docs.'),
  };

  const inRouter = useInRouterContext();
  const [filter, setFilter] = useState<ListFilter>(DEFAULT_FILTER);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('all');

  const { stats, entries, projects, total, isLoading, reload } = useMemoryIndex(filter);
  const { selectedId, selected, selectEntry, clearSelection } = useSelectedEntry();

  const [composerOpen, setComposerOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<(MemoryEntry & { body: string }) | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const searchRef = useRef<RefInputType>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  // Keyboard: ⌘K / "/" focus search; ⌘N open quick-add
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // "/" focuses search (not in input)
      if (e.key === '/') {
        const active = document.activeElement;
        const isInput =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLElement && active.isContentEditable);
        if (!isInput) {
          e.preventDefault();
          searchRef.current?.focus();
        }
        return;
      }
      // ⌘K focuses search
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // ⌘N opens composer modal
      if (e.key === 'n' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setComposerOpen(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // TopbarChips type filter
  const [activeChipType, setActiveChipType] = useState<MemoryType | null>(null);
  const handleChipFilter = useCallback((type: MemoryType | null) => {
    setActiveChipType(type);
    setFilter((prev) => ({
      ...prev,
      types: type ? [type] : [],
    }));
  }, []);

  // Project dropdown
  const handleProjectSelect = useCallback((projectId: string | null) => {
    setFilter((prev) => ({
      ...prev,
      project: projectId ?? 'all',
    }));
  }, []);

  // Time dropdown
  const handleTimeSelect = useCallback((tw: TimeWindow) => {
    setTimeWindow(tw);
    setFilter((prev) => ({
      ...prev,
      timeWindow: timeWindowToFilter(tw),
    }));
  }, []);

  // Type dropdown (multi-select - overrides chip single-select)
  const handleTypeFilter = useCallback((types: MemoryType[]) => {
    setActiveChipType(types.length === 1 ? (types[0] ?? null) : null);
    setFilter((prev) => ({ ...prev, types }));
  }, []);

  // Search
  const handleSearchChange = useCallback((val: string) => {
    setFilter((prev) => ({ ...prev, search: val, offset: 0 }));
  }, []);

  // Row select: click same row → deselect
  const handleSelectRow = useCallback(
    (id: string) => {
      if (id === selectedId) {
        clearSelection();
      } else {
        selectEntry(id);
      }
    },
    [selectedId, clearSelection, selectEntry]
  );

  // Edit an entry (#414): the selected entry already carries its full body.
  const handleEdit = useCallback((entry: MemoryEntry & { body: string }) => {
    setEditTarget(entry);
  }, []);

  // After a successful edit, re-select by the (possibly new) id and refresh.
  const handleEditorSaved = useCallback(
    (newId: string) => {
      setEditTarget(null);
      reload();
      selectEntry(newId);
    },
    [reload, selectEntry]
  );

  // Archive an entry. The brain is append-only: archiving only hides the memory
  // from Wayland (restorable from Archived); the brain keeps the original.
  const handleArchive = useCallback(
    (entry: MemoryEntry & { body: string }) => {
      Modal.confirm({
        title: t('archive.delete.confirmTitle', 'Archive this memory?'),
        content: t(
          'archive.delete.confirmContent',
          'This hides the memory from Wayland. Your brain keeps the original, and you can restore it anytime from Archived.'
        ),
        okText: t('archive.delete.confirmOk', 'Archive'),
        cancelText: t('archive.delete.confirmCancel', 'Cancel'),
        onOk: async () => {
          const result = await memoryBridge.deleteEntry.invoke({ id: entry.id });
          if (result.ok) {
            Message.success(t('archive.delete.toastDeleted', 'Memory archived. Restore it anytime from Archived.'));
            clearSelection();
            reload();
            setArchivedOpen(true);
          } else {
            Message.error(result.error || t('archive.delete.toastError', 'Could not archive memory'));
          }
        },
      });
    },
    [t, clearSelection, reload]
  );

  const handleCopy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text);
      Message.success(t('archive.toast.copied', 'Copied'));
    },
    [t]
  );

  // Cursor pagination (no-deferment #5)
  const handleEndReached = useCallback(() => {
    if (entries.length < total) {
      setFilter((prev) => ({ ...prev, offset: entries.length }));
    }
  }, [entries.length, total]);

  // Determine empty state
  const hasActiveFilters =
    (filter.types?.length ?? 0) > 0 ||
    (filter.search?.length ?? 0) > 0 ||
    filter.project !== 'all' ||
    filter.timeWindow !== 'all';

  const showEmptyHero = entries.length === 0 && !isLoading && !hasActiveFilters;

  // Result count for filter bar
  const resultCountLabel = isLoading ? '' : `${total.toLocaleString()} ${t('archive.filter.results', 'results')}`;

  // Workspaces the composer can save to, and the one it starts on: the page's
  // workspace filter when set, else the shared `general` workspace.
  const composerWorkspaces = projects.map((p) => p.basename);
  const filterWorkspace = filter.project && filter.project !== 'all' ? filter.project.replace(/^brain:\/\//, '') : null;
  const composerDefaultWorkspace = filterWorkspace ?? GLOBAL_WORKSPACE;

  const projectSelected = filter.project !== 'all' ? filter.project : null;
  const typeCounts = stats?.typeCounts ?? {
    decision: 0,
    pattern: 0,
    session: 0,
    observation: 0,
    wiki: 0,
    preference: 0,
  };

  // ── Drag-drop handlers ──────────────────────────────────────────────────────
  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only reset if the pointer leaves the shell root entirely (not into a child).
    const related = e.relatedTarget as Node | null;
    if (shellRef.current && related && shellRef.current.contains(related)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);

      const ALLOWED = new Set(['.md', '.markdown', '.txt', '.json']);
      const files = Array.from(e.dataTransfer.files).filter((f) => {
        const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
        return ALLOWED.has(ext);
      });

      if (files.length === 0) return;

      try {
        const filePayloads = await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() })));
        const result = await memoryBridge.ingestFiles.invoke({ files: filePayloads });
        if (result.ingested > 0) {
          Message.success(
            t('archive.dragDrop.toastIngested', `Ingested ${result.ingested} file${result.ingested === 1 ? '' : 's'}`)
          );
          reload();
        } else {
          Message.warning(result.errors?.[0] || t('archive.dragDrop.toastNoFiles', 'No files were ingested'));
        }
      } catch (err) {
        Message.error(t('archive.dragDrop.toastError', 'Drop ingest failed'));
        console.error('[FullPanelShell] drag-drop ingest error', err);
      }
    },
    [reload, t]
  );

  return (
    <div
      ref={shellRef}
      className={styles.shell}
      data-testid='memory-full-panel'
      role='region'
      aria-label='Memory Archive'
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => {
        void handleDrop(e);
      }}
    >
      {inRouter && <UrlTypeSync onType={handleChipFilter} />}
      {/* ---- Drag-drop overlay ---- */}
      {dragOver && (
        <div className={styles.dragOverlay} aria-hidden>
          <span className={styles.dragOverlayLabel}>
            {t('archive.dragDrop.overlay', 'Drop .md, .txt or .json notes to save them to your brain')}
          </span>
        </div>
      )}
      {/* ---- Topbar (56px) ---- */}
      <header className={styles.topbar}>
        <div className={styles.topbarLeft}>
          {/* Breadcrumb */}
          <span className={styles.breadcrumb} data-testid='memory-full-panel-heading'>
            <span className={styles.breadcrumbIcon} aria-hidden>
              <Archive size={20} />
            </span>
            <span className={styles.breadcrumbPrimary}>{t('archive.topbar.archive', 'Archive')}</span>
            <span className={styles.breadcrumbSep} aria-hidden>
              ·
            </span>
            <span className={styles.breadcrumbProject}>
              {filterWorkspace ?? t('archive.topbar.allWorkspaces', 'All workspaces')}
            </span>
          </span>

          {/* Type chips (no-deferment #1) */}
          <TopbarChips
            typeCounts={typeCounts}
            activeType={activeChipType}
            onFilterChange={handleChipFilter}
            descriptions={chipDescriptions}
          />

          {/* Streak pill (no-deferment #2) */}
          {stats?.streak && <StreakPill sessions={stats.streak.sessions} longestDays={stats.streak.longestDays} />}
        </div>

        <div className={styles.topbarActions}>
          <Button
            type='text'
            size='small'
            icon={<ArchiveRestore size={15} aria-hidden />}
            onClick={() => setArchivedOpen(true)}
            data-testid='memory-btn-archived'
          >
            {t('archive.topbar.archived', 'Archived')}
          </Button>
          {/* Quick-add → opens ComposerModal */}
          <Button
            type='primary'
            size='small'
            icon={<Plus size={13} aria-hidden />}
            onClick={() => setComposerOpen(true)}
            data-testid='memory-btn-quickadd'
            className={styles.addBtn}
          >
            {t('archive.topbar.add', 'Add')}
          </Button>
        </div>
      </header>

      {/* ---- Scope label ---- */}
      <p className={styles.scopeLabel} data-testid='memory-scope-label'>
        {t(
          'archive.scopeLabel',
          'Everything here lives in your brain MCP server, so your agents and this page share the same memories.'
        )}
      </p>

      {/* ---- Filter bar (48px) ---- */}
      <div className={styles.filterBar} data-testid='memory-filter-bar'>
        <div className={styles.filterLeft}>
          <Input
            ref={searchRef}
            className={styles.searchInput}
            prefix={<Search size={14} />}
            suffix={
              <kbd className={styles.searchKbd} data-testid='memory-search-kbd'>
                {formatModifierShortcut('K')}
              </kbd>
            }
            placeholder={t('archive.filter.searchPlaceholder', 'Search memories… (type:decision tag:design)')}
            value={filter.search ?? ''}
            onChange={handleSearchChange}
            allowClear
            data-testid='memory-search-input'
          />
        </div>
        <div className={styles.filterDropdowns}>
          <ProjectDropdown projects={projects} selected={projectSelected} onSelect={handleProjectSelect} />
          <TimeDropdown selected={timeWindow} onSelect={handleTimeSelect} />
          <TypeDropdown typeCounts={typeCounts} selected={filter.types ?? []} onFilterChange={handleTypeFilter} />
        </div>
        <div className={styles.resultCount} data-testid='memory-result-count'>
          {resultCountLabel}
        </div>
      </div>

      {/* ---- Main area (1fr) ---- */}
      <div className={styles.main} data-testid='memory-body'>
        {showEmptyHero ? (
          <EmptyStateHero onSearchChange={handleSearchChange} onAdd={() => setComposerOpen(true)} />
        ) : (
          <>
            {/* List column - shrinks when drawer opens (push-content) */}
            <div
              className={`${styles.listCol}${selectedId ? ` ${styles.listColDrawerOpen}` : ''}`}
              data-testid='memory-list-col'
            >
              <MemoryList
                entries={entries}
                total={total}
                selectedId={selectedId ?? undefined}
                onSelect={handleSelectRow}
                search={filter.search ?? ''}
                onSearchChange={handleSearchChange}
                typeFilter={filter.types ?? []}
                onTypeFilterChange={handleTypeFilter}
                typeCounts={typeCounts}
                onEndReached={handleEndReached}
              />
            </div>

            {/* Right drawer - push-content, 480px.
              #792: contain a detail-panel render error (the #751 class) to the
              drawer so the list stays usable. resetKeys (not a React key) clears
              the fallback when the user picks another entry, so switching rows
              recovers from a crash tied to one entry's data - without remounting
              the drawer on open/close, which would break its width transition. */}
            <ErrorBoundary resetKeys={[selectedId]}>
              <RightDrawer
                entry={selected}
                onClose={clearSelection}
                onCopy={handleCopy}
                onEdit={handleEdit}
                onArchive={handleArchive}
              />
            </ErrorBoundary>
          </>
        )}
      </div>

      {/* ---- Status bar (28px) ---- */}
      <MemoryStatusBar brainLive={!isLoading && stats !== null} total={stats?.total ?? total} />

      {/* ---- Composer modal ---- */}
      <ComposerModal
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        workspaces={composerWorkspaces}
        defaultWorkspace={composerDefaultWorkspace}
      />

      {/* ---- Entry editor modal (#414) ---- */}
      <EntryEditorModal
        open={editTarget !== null}
        entry={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={handleEditorSaved}
      />

      <ArchivedMemoryModal open={archivedOpen} onClose={() => setArchivedOpen(false)} onRestored={reload} />
    </div>
  );
};

export default FullPanelShell;
