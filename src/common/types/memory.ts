/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared types for the v0.6.4 Memory Archive IPC surface.
 */

export type MemoryType = 'decision' | 'pattern' | 'observation' | 'session' | 'wiki' | 'preference';

export type MemoryEntry = {
  id: string;
  type: MemoryType;
  project: string;
  projectPath: string;
  summary: string;
  bodyPreview: string;
  body?: string;
  why?: string;
  howToApply?: string;
  tags: string[];
  storedAt: number;
  sourcePath: string;
  sourceLine: number;
  referencedBy: number;
  promotionScore: number;
};

/** A memory entry removed from the active index but retained for restoration. */
export type ArchivedMemoryEntry = {
  archiveId: string;
  summary: string;
  archivedAt: number;
  sourcePath: string;
};

export type ListFilter = {
  project?: 'this' | 'all' | 'global' | string;
  types?: MemoryType[];
  tags?: string[];
  timeWindow?: 'all' | 'today' | '7d' | '30d';
  search?: string;
  sort?: 'recent' | 'most-referenced' | 'highest-score';
  offset?: number;
  limit?: number;
};

export type SparklineData = number[];

export type StatDeltas = {
  total24h: number;
  total7d: number;
  decisions24h: number;
  decisions7d: number;
  wiki24h: number;
  wiki7d: number;
  sessions24h: number;
  sessions7d: number;
};

export type StatKey = 'total' | 'banked' | 'decisions' | 'wiki' | 'sessions' | 'projects';

export type MemoryStats = {
  total: number;
  decisions: number;
  wiki: number;
  sessions: number;
  projects: number;
  banked: number;
  deltas: StatDeltas;
  sparkline: SparklineData;
  sparklines: Record<StatKey, number[]>;
  /**
   * Count of entries grouped by MemoryType. All six keys are always present
   * (zero-filled) so the renderer can render "Decisions (0)" without optional
   * chaining.
   */
  typeCounts: Record<MemoryType, number>;
  /**
   * Activity streak computed from the disk index across all projects.
   * `sessions`     = total count of distinct UTC calendar days with any stored entry.
   * `longestDays`  = longest consecutive-day run in the per-disk-index history.
   * `lastActiveDayMs` = midnight-UTC epoch ms of the most recent active day, so
   *                  the renderer can compute "X days since last activity".
   */
  streak: {
    sessions: number;
    longestDays: number;
    lastActiveDayMs: number;
  };
};

export type IndexStats = {
  total: number;
  projects: number;
  lastIndexedAt: number;
};

export type ProjectSummary = {
  path: string;
  basename: string;
  count: number;
  lastActive: number;
  /**
   * True for the machine-wide store at `~/.ijfw/memory`, which #137 injects into
   * this list as an ordinary project so the Memory tab can browse imported and
   * global-scoped memories. It is NOT a project: `loadGlobalMemoryBlock` feeds it
   * into every chat in every project, so a `project`-scoped save must never be
   * able to name it. Consumers that turn this list into a WRITE destination (the
   * composer's picker, `resolveProjectMemoryDir`) must drop it; consumers that
   * only browse keep it.
   */
  isGlobalStore?: boolean;
};

export type TagCount = {
  tag: string;
  count: number;
};

/**
 * Discriminated union result for memory.get-stats IPC call.
 * Using a wrapper so the renderer can safely distinguish success from failure.
 */
export type GetStatsResult = { ok: true; stats: MemoryStats } | { ok: false; error: string };
