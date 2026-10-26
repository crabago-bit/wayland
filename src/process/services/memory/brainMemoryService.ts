/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wayland's Memory, served entirely from the user's brain MCP server.
 *
 * Every memory is a brain chunk, read and written through the brain's own MCP tools
 * (`get_chunks`, `search`, `stats`, `ingest`, `supersede`). Nothing is kept on disk beside
 * a small list of ids the user has archived or replaced, so the page and every chat see
 * the same memories.
 *
 * Categories. The brain's lifecycle tiers (working / episodic / semantic / procedural) say
 * how consolidated a chunk is, not what it is, so they are not used as categories. A chunk
 * is classified from its title prefix and source instead, using the conventions the user's
 * agents already write with (`hard rule:`, `pattern:`, `bug fix:`, `agent hire:` ...):
 *   decision    deploy choices, governance, hires, routines, plans
 *   preference  hard rules and standing preferences
 *   pattern     patterns, bug fixes, incidents, lessons, topology
 *   session     "session ended" logs, summaries, heartbeats
 *   wiki        notes imported from Obsidian, files, URLs, Paperclip docs
 *   observation everything else
 * The classification is a pure function of the chunk, so counts, filters and the list
 * always agree. Entries written from Wayland get the matching title prefix, so a memory
 * saved as a Decision comes back as a Decision.
 *
 * The brain is append-only. Editing stores a new chunk and records a supersession; deleting
 * hides the entry from Wayland's views (recoverably) without touching the brain.
 */

import type {
  ArchivedMemoryEntry,
  IndexStats,
  ListFilter,
  MemoryEntry,
  MemoryStats,
  MemoryType,
  ProjectSummary,
  StatKey,
  TagCount,
} from '@/common/types/memory';

/** The seam to the brain MCP server; tests inject a fake. */
export interface BrainTools {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** Wayland's own bookkeeping about brain chunks it hides; the brain itself is never edited. */
export type HiddenRecord = {
  archiveId: string;
  entryId: string;
  /** `archived`: the user deleted it (listed under Archived). `superseded`: replaced by an edit. */
  kind: 'archived' | 'superseded';
  summary: string;
  sourcePath: string;
  archivedAt: number;
};

export interface HiddenStore {
  load(): Promise<HiddenRecord[]>;
  save(records: HiddenRecord[]): Promise<void>;
}

type BrainChunk = {
  id: string;
  title?: string | null;
  content?: string | null;
  source_type?: string | null;
  tier?: string | null;
  confidence?: number | null;
  access_count?: number | null;
  created_at?: string | null;
  workspace?: string | null;
};

type BrainStats = { total: number; by_tier?: Record<string, number>; by_workspace?: Record<string, number> };

type Entry = MemoryEntry & { body: string };
type ChangeCallback = (stats: IndexStats) => void;

const GLOBAL_WORKSPACE = 'general';
const PREVIEW_CHARS = 280;
const MAX_CHUNKS_PER_WORKSPACE = 20_000;
const INDEX_TTL_MS = 60_000;
const DAY_MS = 86_400_000;
const MIN_CONTENT_CHARS = 40;
const SEARCH_LIMIT = 100;
const MEMORY_TYPES: readonly MemoryType[] = ['decision', 'pattern', 'observation', 'session', 'wiki', 'preference'];

const DECISION_PREFIXES = new Set([
  'decision',
  'deploy choice',
  'governance',
  'agent hire',
  'agent roster',
  'routine',
  'company build',
  'plan',
  'policy',
  'approval',
]);
const PREFERENCE_PREFIXES = new Set(['hard rule', 'rule', 'standing rule', 'preference', 'convention']);
const PATTERN_PREFIXES = new Set(['pattern', 'bug fix', 'bug', 'incident', 'lesson', 'topology', 'recipe', 'runbook']);
const SESSION_PREFIXES = new Set(['session summary', 'session']);
const WIKI_SOURCES = ['obsidian', 'file', 'url', 'paperclip', 'crystallize'];

/** Title prefix that makes a memory written from Wayland classify as the category chosen. */
const TYPE_TITLE_PREFIX: Record<MemoryType, string> = {
  decision: 'decision: ',
  pattern: 'pattern: ',
  preference: 'preference: ',
  session: 'session summary: ',
  wiki: '[wiki] ',
  observation: '',
};

const titlePrefix = (title: string): string | undefined =>
  /^([a-z][a-z0-9 _/-]{1,32}?):/.exec(title.trim().toLowerCase())?.[1]?.trim();

/** The category of a chunk: a pure function of its title, content and source. */
export function classifyChunk(chunk: Pick<BrainChunk, 'title' | 'content' | 'source_type'>): MemoryType {
  const title = (chunk.title ?? '').trim();
  const lower = title.toLowerCase();
  const prefix = titlePrefix(title);
  if (prefix && PREFERENCE_PREFIXES.has(prefix)) return 'preference';
  if (prefix && DECISION_PREFIXES.has(prefix)) return 'decision';
  if (prefix && PATTERN_PREFIXES.has(prefix)) return 'pattern';
  if (lower.startsWith('[wiki]')) return 'wiki';
  const firstLine = (chunk.content ?? '').split('\n', 1)[0].toLowerCase();
  if (
    (prefix && SESSION_PREFIXES.has(prefix)) ||
    /\bheartbeat\b/.test(lower) ||
    /\bsession (ended|summary)\b/.test(firstLine) ||
    /\bsession (ended|summary)\b/.test(lower)
  ) {
    return 'session';
  }
  const source = (chunk.source_type ?? '').toLowerCase();
  if (lower.startsWith('[obsidian]') || WIKI_SOURCES.some((s) => source === s || source.startsWith(`${s}:`))) {
    return 'wiki';
  }
  return 'observation';
}

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

export function chunkToEntry(chunk: BrainChunk, workspace: string): Entry {
  const body = chunk.content ?? '';
  const ws = chunk.workspace ?? workspace;
  const source = (chunk.source_type ?? '').split(':')[0].trim();
  const type = classifyChunk(chunk);
  const tags = [...new Set([type, ...(chunk.tier ? [chunk.tier] : []), ...(source ? [source] : [])])];
  return {
    id: chunk.id,
    type,
    project: ws,
    projectPath: `brain://${ws}`,
    summary: (chunk.title || body.split('\n')[0] || '(untitled)').slice(0, 500),
    bodyPreview: body.slice(0, PREVIEW_CHARS),
    body,
    tags,
    storedAt: chunk.created_at ? Date.parse(chunk.created_at) || 0 : 0,
    sourcePath: `brain://${ws}/${chunk.id}`,
    sourceLine: 0,
    referencedBy: chunk.access_count ?? 0,
    promotionScore: Math.max(0, Math.min(100, Math.round((chunk.confidence ?? 0) * 100))),
  };
}

type Index = { at: number; entries: Entry[]; byId: Map<string, Entry> };

const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

export class BrainMemoryService {
  private index: Index | null = null;
  private loading: Promise<Index> | null = null;
  private hidden: HiddenRecord[] | null = null;
  private readonly listeners = new Set<ChangeCallback>();
  private lastIndexedAt = 0;

  constructor(
    private readonly brain: BrainTools,
    private readonly store: HiddenStore = { load: async () => [], save: async () => undefined }
  ) {}

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    await this.ensureIndex();
  }

  dispose(): void {
    this.listeners.clear();
    this.index = null;
    this.loading = null;
  }

  onIndexChange(cb: ChangeCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  indexStats(): IndexStats {
    const visible = this.index?.entries ?? [];
    return {
      total: visible.length,
      projects: new Set(visible.map((e) => e.project)).size,
      lastIndexedAt: this.lastIndexedAt,
    };
  }

  private notify(): void {
    const stats = this.indexStats();
    for (const cb of this.listeners) cb(stats);
  }

  // ---------------------------------------------------------------- brain access

  private async tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return parseToolResult(await this.brain.callTool(name, args)) as T;
  }

  private async hiddenRecords(): Promise<HiddenRecord[]> {
    this.hidden ??= await this.store.load().catch((): HiddenRecord[] => []);
    return this.hidden;
  }

  private async saveHidden(records: HiddenRecord[]): Promise<void> {
    this.hidden = records;
    await this.store.save(records);
  }

  /** Every chunk of every non-empty workspace, classified. Cached briefly and shared. */
  private async ensureIndex(force = false): Promise<Index> {
    if (!force && this.index && Date.now() - this.index.at < INDEX_TTL_MS) return this.index;
    this.loading ??= this.loadIndex().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loadIndex(): Promise<Index> {
    const stats = await this.tool<BrainStats>('stats');
    const workspaces = Object.entries(stats.by_workspace ?? {})
      .filter(([, n]) => n > 0)
      .map(([name]) => name);
    const hiddenIds = new Set((await this.hiddenRecords()).map((r) => r.entryId));
    const batches = await Promise.all(
      workspaces.map(async (workspace) => {
        const raw = await this.tool<BrainChunk[] | { chunks?: BrainChunk[] }>('get_chunks', {
          workspace,
          limit: MAX_CHUNKS_PER_WORKSPACE,
        });
        const chunks = Array.isArray(raw) ? raw : (raw?.chunks ?? []);
        return chunks.filter((c) => c?.id && !hiddenIds.has(c.id)).map((c) => chunkToEntry(c, workspace));
      })
    );
    const entries = batches.flat().sort((a, b) => b.storedAt - a.storedAt);
    const next: Index = { at: Date.now(), entries, byId: new Map(entries.map((e) => [e.id, e])) };
    const changed = !this.index || this.index.entries.length !== entries.length;
    this.index = next;
    this.lastIndexedAt = next.at;
    if (changed) this.notify();
    return next;
  }

  // ---------------------------------------------------------------- stats

  async getStats(): Promise<MemoryStats> {
    const { entries } = await this.ensureIndex();
    const typeCounts = Object.fromEntries(MEMORY_TYPES.map((t) => [t, 0])) as Record<MemoryType, number>;
    for (const e of entries) typeCounts[e.type] += 1;

    const now = Date.now();
    const today = startOfUtcDay(now);
    const since = (ms: number, pred: (e: Entry) => boolean) =>
      entries.filter((e) => e.storedAt >= now - ms && pred(e)).length;
    const always = () => true;
    const dayBuckets = (pred: (e: Entry) => boolean): number[] => {
      const out = Array(7).fill(0) as number[];
      for (const e of entries) {
        if (!pred(e)) continue;
        const age = Math.floor((today - startOfUtcDay(e.storedAt)) / DAY_MS);
        if (age >= 0 && age < 7) out[6 - age] += 1;
      }
      return out;
    };
    const isDecision = (e: Entry) => e.type === 'decision';
    const isWiki = (e: Entry) => e.type === 'wiki';
    const isSession = (e: Entry) => e.type === 'session';
    const isBanked = (e: Entry) => e.type !== 'observation' && e.type !== 'session';
    const projects = new Set(entries.map((e) => e.project));

    const days = [...new Set(entries.map((e) => startOfUtcDay(e.storedAt)).filter((d) => d > 0))].sort((a, b) => a - b);
    let longest = 0;
    let run = 0;
    for (let i = 0; i < days.length; i++) {
      run = i > 0 && days[i] - days[i - 1] === DAY_MS ? run + 1 : 1;
      longest = Math.max(longest, run);
    }

    const sparklines: Record<StatKey, number[]> = {
      total: dayBuckets(always),
      banked: dayBuckets(isBanked),
      decisions: dayBuckets(isDecision),
      wiki: dayBuckets(isWiki),
      sessions: dayBuckets(isSession),
      projects: Array(7).fill(projects.size) as number[],
    };
    return {
      total: entries.length,
      decisions: typeCounts.decision,
      wiki: typeCounts.wiki,
      sessions: typeCounts.session,
      projects: projects.size,
      banked: entries.filter(isBanked).length,
      deltas: {
        total24h: since(DAY_MS, always),
        total7d: since(7 * DAY_MS, always),
        decisions24h: since(DAY_MS, isDecision),
        decisions7d: since(7 * DAY_MS, isDecision),
        wiki24h: since(DAY_MS, isWiki),
        wiki7d: since(7 * DAY_MS, isWiki),
        sessions24h: since(DAY_MS, isSession),
        sessions7d: since(7 * DAY_MS, isSession),
      },
      sparkline: sparklines.total,
      sparklines,
      typeCounts,
      streak: { sessions: days.length, longestDays: longest, lastActiveDayMs: days[days.length - 1] ?? 0 },
    };
  }

  // ---------------------------------------------------------------- reading

  private workspaceOf(project: ListFilter['project']): string | null {
    if (!project || project === 'all' || project === 'this') return null;
    if (project === 'global') return GLOBAL_WORKSPACE;
    return project.replace(/^brain:\/\//, '');
  }

  async listEntries(filter: ListFilter = {}): Promise<{ entries: MemoryEntry[]; total: number }> {
    const { entries: all, byId } = await this.ensureIndex();
    const workspace = this.workspaceOf(filter.project);
    let entries = workspace ? all.filter((e) => e.project === workspace) : all;

    const search = filter.search?.trim();
    let relevance: Map<string, number> | null = null;
    if (search) {
      const targets = workspace ? [workspace] : [...new Set(all.map((e) => e.project))];
      const ranked = await Promise.all(
        targets.map(async (ws): Promise<BrainChunk[]> => {
          try {
            const raw = await this.tool<BrainChunk[] | { chunks?: BrainChunk[] }>('search', {
              query: search,
              workspace: ws,
              limit: SEARCH_LIMIT,
              mode: 'hybrid',
            });
            return Array.isArray(raw) ? raw : (raw?.chunks ?? []);
          } catch {
            return [];
          }
        })
      );
      const scores = new Map<string, number>();
      ranked.flat().forEach((c, i) => c?.id && byId.has(c.id) && scores.set(c.id, i));
      relevance = scores;
      const needle = search.toLowerCase();
      // Brain hits first; entries whose text contains the query also count, so a literal
      // phrase is never missed by the semantic search.
      entries = entries.filter(
        (e) => scores.has(e.id) || e.summary.toLowerCase().includes(needle) || e.body.toLowerCase().includes(needle)
      );
    }
    if (filter.types && filter.types.length > 0) entries = entries.filter((e) => filter.types!.includes(e.type));
    if (filter.tags && filter.tags.length > 0) {
      entries = entries.filter((e) => filter.tags!.every((t) => e.tags.includes(t)));
    }
    if (filter.timeWindow && filter.timeWindow !== 'all') {
      const span = filter.timeWindow === 'today' ? DAY_MS : filter.timeWindow === '7d' ? 7 * DAY_MS : 30 * DAY_MS;
      entries = entries.filter((e) => e.storedAt >= Date.now() - span);
    }
    const sort = filter.sort ?? (relevance ? 'relevance' : 'recent');
    const rank = relevance;
    entries = [...entries].sort((a, b) => {
      if (sort === 'most-referenced') return b.referencedBy - a.referencedBy;
      if (sort === 'highest-score') return b.promotionScore - a.promotionScore;
      if (sort === 'relevance' && rank) return (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9);
      return b.storedAt - a.storedAt;
    });

    const offset = filter.offset ?? 0;
    const page = entries.slice(offset, offset + (filter.limit ?? 100)).map(({ body: _body, ...entry }) => entry);
    return { entries: page, total: entries.length };
  }

  async getEntry(id: string): Promise<(Entry & { bodyIsPreview?: boolean }) | null> {
    return (await this.ensureIndex()).byId.get(id) ?? null;
  }

  async getProjects(): Promise<ProjectSummary[]> {
    const { entries } = await this.ensureIndex();
    const byProject = new Map<string, { count: number; last: number }>();
    for (const e of entries) {
      const cur = byProject.get(e.project) ?? { count: 0, last: 0 };
      cur.count += 1;
      cur.last = Math.max(cur.last, e.storedAt);
      byProject.set(e.project, cur);
    }
    return [...byProject.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, v]) => ({
        path: `brain://${name}`,
        basename: name,
        count: v.count,
        lastActive: v.last,
        ...(name === GLOBAL_WORKSPACE ? { isGlobalStore: true } : {}),
      }));
  }

  async getTags(project?: string): Promise<TagCount[]> {
    const { entries } = await this.ensureIndex();
    const workspace = this.workspaceOf(project);
    const counts = new Map<string, number>();
    for (const e of entries) {
      if (workspace && e.project !== workspace) continue;
      for (const tag of e.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }));
  }

  // ---------------------------------------------------------------- writing

  private titleFor(type: MemoryType, summary: string): string {
    // Drop a category prefix the text already carries so the chosen category is the only one.
    const stripped = summary
      .replace(/^\[wiki\]\s*/i, '')
      .replace(/^([a-z][a-z0-9 _/-]{1,32}?):\s*/i, (m, p: string) => {
        const prefix = p.trim().toLowerCase();
        const known =
          DECISION_PREFIXES.has(prefix) ||
          PREFERENCE_PREFIXES.has(prefix) ||
          PATTERN_PREFIXES.has(prefix) ||
          SESSION_PREFIXES.has(prefix);
        return known ? '' : m;
      });
    return `${TYPE_TITLE_PREFIX[type]}${stripped}`.slice(0, 200);
  }

  private async ingest(content: string, workspace: string, title: string): Promise<string> {
    const created = await this.tool<{ chunk_id?: string; id?: string }>('ingest', {
      content,
      workspace,
      title,
      source_type: 'paste',
    });
    const id = created?.chunk_id ?? created?.id;
    if (!id) throw new Error('The brain did not return the new memory id');
    return id;
  }

  /** Save a new memory to the brain. `projectPath` is `brain://<workspace>` for a project scope. */
  async quickAdd(content: string, scope: 'project' | 'global', type?: string, projectPath?: string): Promise<void> {
    const text = content.trim();
    if (text.length < MIN_CONTENT_CHARS) {
      throw new Error(`A brain memory needs at least ${MIN_CONTENT_CHARS} characters of substance`);
    }
    await this.ensureIndex(); // so the new memory can be shown at once, not after the next refresh
    const fromPath = projectPath?.startsWith('brain://') ? projectPath.slice('brain://'.length) : '';
    const workspace = scope === 'global' || !fromPath ? GLOBAL_WORKSPACE : fromPath;
    const category = (MEMORY_TYPES as readonly string[]).includes(type ?? '') ? (type as MemoryType) : 'observation';
    const title = this.titleFor(category, text.split('\n', 1)[0]);
    const id = await this.ingest(text, workspace, title);
    this.addToIndex(
      chunkToEntry(
        { id, title, content: text, source_type: 'paste', created_at: new Date().toISOString(), confidence: 0.15 },
        workspace
      )
    );
  }

  /** Save dropped notes as Wiki memories in the global workspace. */
  async ingestFiles(
    files: ReadonlyArray<{ name: string; content: string }>
  ): Promise<{ ok: boolean; ingested: number; errors: string[] }> {
    await this.ensureIndex();
    let ingested = 0;
    const errors: string[] = [];
    for (const file of files) {
      const base = file.name.replace(/\.[^.]+$/, '').trim();
      if (!base || file.name.includes('..') || file.name.includes('/') || file.name.includes('\\')) {
        errors.push(`${file.name}: rejected - invalid name`);
        continue;
      }
      const text = file.content.trim().slice(0, 100_000);
      if (text.length < MIN_CONTENT_CHARS) {
        errors.push(`${file.name}: too short to keep (needs ${MIN_CONTENT_CHARS} characters)`);
        continue;
      }
      try {
        const title = this.titleFor('wiki', base);
        const id = await this.ingest(text, GLOBAL_WORKSPACE, title);
        this.addToIndex(
          chunkToEntry(
            { id, title, content: text, source_type: 'file', created_at: new Date().toISOString(), confidence: 0.15 },
            GLOBAL_WORKSPACE
          )
        );
        ingested += 1;
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ok: true, ingested, errors };
  }

  /** Append a revised chunk and supersede the old one (the brain never edits in place). */
  async editEntry(
    id: string,
    patch: { summary?: string; type?: string; tags?: string[]; body?: string }
  ): Promise<{ ok: boolean; error?: string; newId?: string }> {
    const old = (await this.ensureIndex()).byId.get(id);
    if (!old) return { ok: false, error: 'That memory is no longer in the brain index' };
    const content = (patch.body ?? old.body).trim();
    if (content.length < MIN_CONTENT_CHARS) {
      return { ok: false, error: `A brain memory needs at least ${MIN_CONTENT_CHARS} characters of substance` };
    }
    const type = (MEMORY_TYPES as readonly string[]).includes(patch.type ?? '') ? (patch.type as MemoryType) : old.type;
    const title = this.titleFor(type, patch.summary ?? old.summary);
    try {
      const newId = await this.ingest(content, old.project, title);
      await this.tool('supersede', { old_chunk_id: id, new_chunk_id: newId, reason: 'Edited in Wayland Memory' });
      await this.saveHidden([
        ...(await this.hiddenRecords()),
        {
          archiveId: crypto.randomUUID(),
          entryId: id,
          kind: 'superseded',
          summary: old.summary,
          sourcePath: old.sourcePath,
          archivedAt: Date.now(),
        },
      ]);
      this.removeFromIndex(id);
      this.addToIndex(
        chunkToEntry(
          { id: newId, title, content, source_type: 'paste', created_at: new Date().toISOString(), confidence: 0.15 },
          old.project
        )
      );
      return { ok: true, newId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private addToIndex(entry: Entry): void {
    if (!this.index) return;
    this.index.entries.unshift(entry);
    this.index.byId.set(entry.id, entry);
    this.notify();
  }

  private removeFromIndex(id: string): void {
    if (!this.index) return;
    this.index.entries = this.index.entries.filter((e) => e.id !== id);
    this.index.byId.delete(id);
  }

  /** Hide a memory from Wayland (recoverable). The brain keeps the chunk. */
  async deleteEntry(id: string): Promise<{ ok: boolean; error?: string; archiveId?: string }> {
    const entry = (await this.ensureIndex()).byId.get(id);
    if (!entry) return { ok: false, error: 'That memory is no longer in the brain index' };
    const archiveId = crypto.randomUUID();
    await this.saveHidden([
      ...(await this.hiddenRecords()),
      {
        archiveId,
        entryId: id,
        kind: 'archived',
        summary: entry.summary,
        sourcePath: entry.sourcePath,
        archivedAt: Date.now(),
      },
    ]);
    this.removeFromIndex(id);
    this.notify();
    return { ok: true, archiveId };
  }

  async listArchivedEntries(): Promise<ArchivedMemoryEntry[]> {
    return (await this.hiddenRecords())
      .filter((r) => r.kind === 'archived')
      .sort((a, b) => b.archivedAt - a.archivedAt)
      .map((r) => ({ archiveId: r.archiveId, summary: r.summary, archivedAt: r.archivedAt, sourcePath: r.sourcePath }));
  }

  async restoreArchivedEntry(archiveId: string): Promise<{ ok: boolean; error?: string }> {
    const records = await this.hiddenRecords();
    if (!records.some((r) => r.archiveId === archiveId && r.kind === 'archived')) {
      return { ok: false, error: 'That archived memory was not found' };
    }
    await this.saveHidden(records.filter((r) => r.archiveId !== archiveId));
    await this.ensureIndex(true);
    this.notify();
    return { ok: true };
  }
}

/** What the Memory bridge needs from its backend. */
export type MemoryBackend = BrainMemoryService;
