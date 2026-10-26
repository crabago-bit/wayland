/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Memory page's data bridge. Memory is the user's brain MCP server: every provider here
 * is a thin, validated pass-through to {@link BrainMemoryService}. With no `brain` server
 * configured there is no store, so reads come back empty and writes say why.
 */

import log from 'electron-log';
import { z } from 'zod';
import { ipcBridge } from '@/common';
import type {
  ArchivedMemoryEntry,
  GetStatsResult,
  ListFilter,
  MemoryEntry,
  ProjectSummary,
  TagCount,
} from '@/common/types/memory';
import type { BrainMemoryService } from '@process/services/memory/brainMemoryService';
import { getBrainMemory } from '@process/services/memory/memoryBackend';

const NO_BRAIN = 'No brain MCP server is configured. Add one named "brain" to use Memory.';

const listFilterSchema = z.object({
  project: z.string().optional(),
  types: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  timeWindow: z.enum(['all', 'today', '7d', '30d']).optional(),
  search: z.string().optional(),
  sort: z.enum(['recent', 'most-referenced', 'highest-score']).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const idSchema = z.object({ id: z.string().min(1).max(64) });
const tagsQuerySchema = z.object({ project: z.string().optional() });

const quickAddSchema = z.object({
  content: z.string().min(1).max(100_000),
  scope: z.enum(['project', 'global']),
  type: z.string().optional(),
  /** `brain://<workspace>` for a project-scoped save. */
  projectPath: z.string().max(4_096).optional(),
});

const updateEntrySchema = z.object({
  id: z.string().min(1).max(64),
  summary: z.string().min(1).max(500).optional(),
  type: z.string().min(1).max(40).optional(),
  tags: z.array(z.string().max(80)).max(50).optional(),
  body: z.string().max(100_000).optional(),
});

const archiveIdSchema = z.object({ archiveId: z.string().uuid() });

const ingestFilesSchema = z.object({
  files: z
    .array(z.object({ name: z.string().min(1).max(255), content: z.string().max(2_000_000) }))
    .min(1)
    .max(50),
});

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function initMemoryArchiveBridge(): void {
  /** Run `fn` against the brain, or fall back when there is none or the call fails. */
  const withBrain = async <T>(
    what: string,
    fn: (brain: BrainMemoryService) => Promise<T>,
    whenNone: () => T,
    onError: (err: unknown) => T
  ): Promise<T> => {
    const brain = await getBrainMemory();
    if (!brain) return whenNone();
    try {
      return await fn(brain);
    } catch (err) {
      log.error(`[memory] ${what} failed`, { err });
      return onError(err);
    }
  };

  // Warm the index in the background so the first page view is not the one that pays for it.
  void getBrainMemory()
    .then((brain) => {
      if (!brain) {
        console.log('[memory] no brain MCP server configured');
        return undefined;
      }
      console.log('[memory] backend=brain');
      brain.onIndexChange((stats) => ipcBridge.memory.onIndexChanged.emit(stats));
      return brain.init();
    })
    .catch((err) => log.warn('[memory] background init failed', { err }));

  ipcBridge.memory.getBackend.provider(async () => ((await getBrainMemory()) ? 'brain' : 'none'));

  ipcBridge.memory.getStats.provider(async () =>
    withBrain<GetStatsResult>(
      'getStats',
      async (b) => ({ ok: true as const, stats: await b.getStats() }),
      () => ({ ok: false as const, error: NO_BRAIN }),
      (err) => ({ ok: false as const, error: message(err) })
    )
  );

  ipcBridge.memory.listEntries.provider(async (rawFilter: unknown) => {
    const parsed = listFilterSchema.safeParse(rawFilter ?? {});
    if (!parsed.success) return { entries: [], total: 0 };
    return withBrain<{ entries: MemoryEntry[]; total: number }>(
      'listEntries',
      (b) => b.listEntries(parsed.data as ListFilter),
      () => ({ entries: [], total: 0 }),
      () => ({ entries: [], total: 0 })
    );
  });

  ipcBridge.memory.getEntry.provider(async (args: unknown) => {
    const parsed = idSchema.safeParse(args);
    if (!parsed.success) return null;
    return withBrain<(MemoryEntry & { body: string }) | null>(
      'getEntry',
      (b) => b.getEntry(parsed.data.id),
      () => null,
      () => null
    );
  });

  ipcBridge.memory.getProjects.provider(async () =>
    withBrain<ProjectSummary[]>(
      'getProjects',
      (b) => b.getProjects(),
      () => [],
      () => []
    )
  );

  ipcBridge.memory.getTags.provider(async (args: unknown) => {
    const parsed = tagsQuerySchema.safeParse(args ?? {});
    const project = parsed.success ? parsed.data.project : undefined;
    return withBrain<TagCount[]>(
      'getTags',
      (b) => b.getTags(project),
      () => [],
      () => []
    );
  });

  ipcBridge.memory.setQuickAdd.provider(async (args) => {
    const parsed = quickAddSchema.safeParse(args);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const { content, scope, type, projectPath } = parsed.data;
    return withBrain<{ ok: boolean; error?: string }>(
      'setQuickAdd',
      async (b) => {
        await b.quickAdd(content, scope, type, projectPath);
        return { ok: true };
      },
      () => ({ ok: false, error: NO_BRAIN }),
      (err) => ({ ok: false, error: message(err) })
    );
  });

  ipcBridge.memory.updateEntry.provider(async (args) => {
    const parsed = updateEntrySchema.safeParse(args);
    if (!parsed.success) return { ok: false, error: 'invalid args' };
    const { id, ...patch } = parsed.data;
    if (
      patch.summary === undefined &&
      patch.type === undefined &&
      patch.tags === undefined &&
      patch.body === undefined
    ) {
      return { ok: false, error: 'no_changes' };
    }
    return withBrain<{ ok: boolean; error?: string; newId?: string }>(
      'updateEntry',
      (b) => b.editEntry(id, patch),
      () => ({ ok: false, error: NO_BRAIN }),
      (err) => ({ ok: false, error: message(err) })
    );
  });

  ipcBridge.memory.deleteEntry.provider(async (args) => {
    const parsed = idSchema.safeParse(args);
    if (!parsed.success) return { ok: false, error: 'invalid id' };
    return withBrain<{ ok: boolean; error?: string; archiveId?: string }>(
      'deleteEntry',
      (b) => b.deleteEntry(parsed.data.id),
      () => ({ ok: false, error: NO_BRAIN }),
      (err) => ({ ok: false, error: message(err) })
    );
  });

  ipcBridge.memory.listArchivedEntries.provider(async () =>
    withBrain<ArchivedMemoryEntry[]>(
      'listArchivedEntries',
      (b) => b.listArchivedEntries(),
      () => [],
      () => []
    )
  );

  ipcBridge.memory.restoreArchivedEntry.provider(async (args) => {
    const parsed = archiveIdSchema.safeParse(args);
    if (!parsed.success) return { ok: false, error: 'invalid archive id' };
    return withBrain<{ ok: boolean; error?: string }>(
      'restoreArchivedEntry',
      (b) => b.restoreArchivedEntry(parsed.data.archiveId),
      () => ({ ok: false, error: NO_BRAIN }),
      (err) => ({ ok: false, error: message(err) })
    );
  });

  ipcBridge.memory.ingestFiles.provider(async (args) => {
    const parsed = ingestFilesSchema.safeParse(args);
    if (!parsed.success) return { ok: false, ingested: 0, errors: ['invalid args'] };
    return withBrain<{ ok: boolean; ingested: number; errors: string[] }>(
      'ingestFiles',
      (b) => b.ingestFiles(parsed.data.files.map((f) => ({ name: String(f.name), content: String(f.content) }))),
      () => ({ ok: false, ingested: 0, errors: [NO_BRAIN] }),
      (err) => ({ ok: false, ingested: 0, errors: [message(err)] })
    );
  });
}
