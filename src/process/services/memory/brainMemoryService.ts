/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Memory page's backend, served from the user's brain MCP server instead of
 * local `.ijfw` files.
 *
 * Every memory the page lists, searches, opens, adds or edits is a brain chunk, read
 * and written through the brain's own MCP tools (`get_chunks`, `search`, `stats`,
 * `ingest`, `supersede`) over the same streamable-HTTP server the agents already use.
 * Nothing is mirrored to disk, so the page and every chat see one set of memories.
 *
 * Mapping: a brain workspace is a project, and the lifecycle tier decides the type
 * (working -> observation, episodic -> session, semantic -> decision, procedural ->
 * pattern). The brain is append-only, so an edit stores a new chunk and records a
 * supersession of the old one; a delete is not offered.
 */

import type {
  ArchivedMemoryEntry,
  GetStatsResult,
  IndexStats,
  ListFilter,
  MemoryEntry,
  MemoryStats,
  MemoryType,
  ProjectSummary,
  PromotionCandidates,
  TagCount,
} from '@/common/types/memory';

/** The seam to the brain MCP server; tests inject a fake. */
export interface BrainTools {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

type BrainChunk = {
  id: string;
  title?: string;
  content?: string;
  source_type?: string;
  tier?: string;
  confidence?: number;
  access_count?: number;
  created_at?: string;
  workspace?: string;
};

type BrainStats = {
  total: number;
  by_tier?: Record<string, number>;
  by_workspace?: Record<string, number>;
};

type ChangeCallback = (stats: IndexStats) => void;

const GLOBAL_WORKSPACE = 'general';
const PREVIEW_CHARS = 280;
const MAX_PER_WORKSPACE = 500;
const CACHE_LIMIT = 5000;
const DAY_MS = 86_400_000;

const TIER_TO_TYPE: Record<string, MemoryType> = {
  working: 'observation',
  episodic: 'session',
  semantic: 'decision',
  procedural: 'pattern',
};
/** A type filter selects these tiers. `wiki` is the long-term knowledge: semantic + procedural. */
const TYPE_TO_TIERS: Partial<Record<MemoryType, readonly string[]>> = {
  observation: ['working'],
  session: ['episodic'],
  decision: ['semantic'],
  pattern: ['procedural'],
  wiki: ['semantic', 'procedural'],
};

/** Brain tool results arrive as JSON text; tolerate both text and already-parsed values. */
export function parseToolResult(result: unknown): unknown {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  const text = Array.isArray(content) ? content.find((c) => c?.type === 'text')?.text : undefined;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

export function chunkToEntry(chunk: BrainChunk, workspace: string): MemoryEntry & { body: string } {
  const body = chunk.content ?? '';
  const tier = chunk.tier ?? 'working';
  const ws = chunk.workspace ?? workspace;
  return {
    id: chunk.id,
    type: TIER_TO_TYPE[tier] ?? 'observation',
    project: ws,
    projectPath: `brain://${ws}`,
    summary: (chunk.title || body.split('\n')[0] || '(untitled)').slice(0, 500),
    bodyPreview: body.slice(0, PREVIEW_CHARS),
    body,
    tags: [tier, ...(chunk.source_type ? [chunk.source_type] : [])],
    storedAt: chunk.created_at ? Date.parse(chunk.created_at) || 0 : 0,
    sourcePath: `brain://${ws}/${chunk.id}`,
    sourceLine: 0,
    referencedBy: chunk.access_count ?? 0,
    promotionScore: Math.max(0, Math.min(100, Math.round((chunk.confidence ?? 0) * 100))),
  };
}

const zeroDeltas = {
  total24h: 0,
  total7d: 0,
  decisions24h: 0,
  decisions7d: 0,
  wiki24h: 0,
  wiki7d: 0,
  sessions24h: 0,
  sessions7d: 0,
};

export class BrainMemoryService {
  private readonly cache = new Map<string, MemoryEntry & { body: string }>();
  private readonly listeners = new Set<ChangeCallback>();
  private lastIndexedAt = 0;
  private projectCount = 0;
  private total = 0;

  constructor(private readonly brain: BrainTools) {}

  async init(): Promise<void> {
    await this.refreshStats();
  }

  dispose(): void {
    this.listeners.clear();
    this.cache.clear();
  }

  onIndexChange(cb: ChangeCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  indexStats(): IndexStats {
    return { total: this.total, projects: this.projectCount, lastIndexedAt: this.lastIndexedAt };
  }

  private async tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return parseToolResult(await this.brain.callTool(name, args)) as T;
  }

  private async brainStats(): Promise<BrainStats> {
    return this.tool<BrainStats>('stats');
  }

  private async refreshStats(): Promise<BrainStats> {
    const stats = await this.brainStats();
    this.total = stats.total ?? 0;
    this.projectCount = Object.values(stats.by_workspace ?? {}).filter((n) => n > 0).length;
    this.lastIndexedAt = Date.now();
    return stats;
  }

  private remember(entry: MemoryEntry & { body: string }): void {
    if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(entry.id, entry);
  }

  private notify(): void {
    const stats = this.indexStats();
    for (const cb of this.listeners) cb(stats);
  }

  async getStats(): Promise<MemoryStats> {
    const s = await this.refreshStats();
    const tier = s.by_tier ?? {};
    const typeCounts: Record<MemoryType, number> = {
      decision: tier.semantic ?? 0,
      pattern: tier.procedural ?? 0,
      observation: tier.working ?? 0,
      session: tier.episodic ?? 0,
      // Long-term knowledge: the semantic and procedural tiers. It overlaps `decision` and
      // `pattern` on purpose, so a total must come from the brain, never from summing these.
      wiki: (tier.semantic ?? 0) + (tier.procedural ?? 0),
      preference: 0,
    };
    const flat = Array(7).fill(0) as number[];
    return {
      total: this.total,
      decisions: typeCounts.decision,
      wiki: typeCounts.wiki,
      sessions: typeCounts.session,
      projects: this.projectCount,
      banked: typeCounts.decision + typeCounts.pattern + typeCounts.session,
      deltas: { ...zeroDeltas },
      sparkline: flat,
      sparklines: { total: flat, banked: flat, decisions: flat, wiki: flat, sessions: flat, projects: flat },
      typeCounts,
      streak: { sessions: 0, longestDays: 0, lastActiveDayMs: 0 },
    };
  }

  /** Workspaces a project filter covers. */
  private async targetWorkspaces(project: ListFilter['project']): Promise<string[]> {
    if (project === 'global') return [GLOBAL_WORKSPACE];
    if (project && project !== 'all' && project !== 'this') return [project.replace(/^brain:\/\//, '')];
    const stats = await this.brainStats();
    return Object.entries(stats.by_workspace ?? {})
      .filter(([, n]) => n > 0)
      .map(([name]) => name);
  }

  async listEntries(filter: ListFilter = {}): Promise<{ entries: MemoryEntry[]; total: number }> {
    const workspaces = await this.targetWorkspaces(filter.project);
    const wantedTiers = filter.types?.flatMap((t) => TYPE_TO_TIERS[t] ?? []);
    const search = filter.search?.trim();
    const perWorkspace = Math.min(MAX_PER_WORKSPACE, Math.max(50, (filter.limit ?? 100) + (filter.offset ?? 0)));

    const batches = await Promise.all(
      workspaces.map(async (workspace) => {
        try {
          const raw = search
            ? await this.tool<BrainChunk[] | { chunks?: BrainChunk[]; results?: BrainChunk[] }>('search', {
                query: search,
                workspace,
                limit: perWorkspace,
                mode: 'hybrid',
              })
            : await this.tool<BrainChunk[]>('get_chunks', { workspace, limit: perWorkspace });
          const chunks = Array.isArray(raw) ? raw : (raw?.chunks ?? raw?.results ?? []);
          return chunks.filter((c) => c?.id).map((c) => chunkToEntry(c, workspace));
        } catch {
          return [];
        }
      })
    );

    let entries = batches.flat();
    for (const e of entries) this.remember(e as MemoryEntry & { body: string });
    if (wantedTiers && wantedTiers.length > 0) {
      entries = entries.filter((e) => wantedTiers.includes(e.tags[0]));
    }
    if (filter.tags && filter.tags.length > 0) {
      entries = entries.filter((e) => filter.tags!.every((t) => e.tags.includes(t)));
    }
    if (filter.timeWindow && filter.timeWindow !== 'all') {
      const span = filter.timeWindow === 'today' ? DAY_MS : filter.timeWindow === '7d' ? 7 * DAY_MS : 30 * DAY_MS;
      const cutoff = Date.now() - span;
      entries = entries.filter((e) => e.storedAt >= cutoff);
    }
    const sort = filter.sort ?? 'recent';
    entries.sort((a, b) =>
      sort === 'most-referenced'
        ? b.referencedBy - a.referencedBy
        : sort === 'highest-score'
          ? b.promotionScore - a.promotionScore
          : b.storedAt - a.storedAt
    );

    const total = entries.length;
    const offset = filter.offset ?? 0;
    const page = entries.slice(offset, offset + (filter.limit ?? 100)).map(({ body: _body, ...entry }) => entry);
    return { entries: page, total };
  }

  async getEntry(id: string): Promise<(MemoryEntry & { body: string }) | null> {
    return this.cache.get(id) ?? null;
  }

  async getProjects(): Promise<ProjectSummary[]> {
    const stats = await this.brainStats();
    return Object.entries(stats.by_workspace ?? {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({
        path: `brain://${name}`,
        basename: name,
        count,
        lastActive: this.lastIndexedAt,
        ...(name === GLOBAL_WORKSPACE ? { isGlobalStore: true } : {}),
      }));
  }

  async getTags(_project?: string): Promise<TagCount[]> {
    const stats = await this.brainStats();
    return Object.entries(stats.by_tier ?? {}).map(([tag, count]) => ({ tag, count }));
  }

  async getPromotionCandidates(threshold = 90): Promise<PromotionCandidates> {
    // The brain promotes working -> episodic -> semantic -> procedural itself; there is
    // nothing for the page to sweep.
    return { candidates: [], threshold, lastRun: 0, nextRun: 0, autoPromoteEnabled: false };
  }

  async quickAdd(content: string, scope: 'project' | 'global', _type?: string, projectPath?: string): Promise<void> {
    const text = content.trim();
    if (text.length < 40) throw new Error('A brain memory needs at least 40 characters of substance');
    const fromPath = projectPath?.startsWith('brain://') ? projectPath.slice('brain://'.length) : '';
    const workspace = scope === 'global' || !fromPath ? GLOBAL_WORKSPACE : fromPath;
    await this.tool('ingest', {
      content: text,
      workspace,
      title: text.split('\n')[0].slice(0, 120),
      source_type: 'paste',
    });
    await this.refreshStats();
    this.notify();
  }

  /** Append a revised chunk and supersede the old one (the brain never edits in place). */
  async editEntry(
    id: string,
    patch: { summary?: string; type?: string; tags?: string[]; body?: string }
  ): Promise<{ ok: boolean; error?: string; newId?: string }> {
    const old = this.cache.get(id);
    if (!old) return { ok: false, error: 'Open the memory from the list first' };
    const content = (patch.body ?? old.body).trim();
    if (content.length < 40) return { ok: false, error: 'A brain memory needs at least 40 characters of substance' };
    const created = await this.tool<{ chunk_id?: string; id?: string }>('ingest', {
      content,
      workspace: old.project,
      title: patch.summary ?? old.summary,
      source_type: 'paste',
    });
    const newId = created?.chunk_id ?? created?.id;
    if (!newId) return { ok: false, error: 'The brain did not return the new memory id' };
    await this.tool('supersede', { old_chunk_id: id, new_chunk_id: newId, reason: 'Edited in Wayland Memory' });
    this.cache.delete(id);
    await this.refreshStats();
    this.notify();
    return { ok: true, newId };
  }

  async deleteEntry(_id: string): Promise<{ ok: boolean; error?: string; archiveId?: string }> {
    return { ok: false, error: 'The brain is append-only: edit the memory to supersede it instead of deleting' };
  }

  async listArchivedEntries(): Promise<ArchivedMemoryEntry[]> {
    return [];
  }

  async restoreArchivedEntry(_archiveId: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'Nothing to restore: the brain keeps superseded memories itself' };
  }
}

/** What the Memory bridge needs from a backend, whether the brain or the local IJFW files. */
export interface MemoryBackend {
  init(): Promise<void>;
  onIndexChange(cb: ChangeCallback): () => void;
  getStats(): Promise<MemoryStats>;
  listEntries(filter?: ListFilter): Promise<{ entries: MemoryEntry[]; total: number }>;
  getEntry(id: string): Promise<(MemoryEntry & { body: string }) | null>;
  getProjects(): Promise<ProjectSummary[]>;
  getTags(project?: string): Promise<TagCount[]>;
  getPromotionCandidates(threshold?: number): Promise<PromotionCandidates>;
  quickAdd(content: string, scope: 'project' | 'global', type?: string, projectPath?: string): Promise<unknown>;
  editEntry(
    id: string,
    patch: { summary?: string; type?: string; tags?: string[]; body?: string }
  ): Promise<{ ok: boolean; error?: string; newId?: string }>;
  deleteEntry(id: string): Promise<{ ok: boolean; error?: string; archiveId?: string }>;
  listArchivedEntries(): Promise<ArchivedMemoryEntry[]>;
  restoreArchivedEntry(archiveId: string): Promise<{ ok: boolean; error?: string }>;
}

export type { GetStatsResult };
