import { describe, expect, it, vi } from 'vitest';
import {
  BrainMemoryService,
  chunkToEntry,
  classifyChunk,
  parseToolResult,
  type BrainTools,
  type HiddenRecord,
  type HiddenStore,
} from '../../src/process/services/memory/brainMemoryService';

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

type Chunk = Record<string, unknown>;
const chunk = (id: string, title: string | null, over: Chunk = {}): Chunk => ({
  id,
  title,
  content: `body of ${id} `.repeat(10),
  source_type: 'paste',
  tier: 'working',
  confidence: 0.42,
  access_count: 3,
  created_at: iso(1),
  ...over,
});

const GENERAL = [
  chunk('d1', 'deploy choice: ship on Monday', { created_at: iso(0) }),
  chunk('r1', 'hard rule: never deploy on Friday', { created_at: iso(2) }),
  chunk('p1', 'bug fix: traefik acme', { created_at: iso(3) }),
  chunk('s1', null, { content: 'claude-code session ended 2026-10-01T00:00:00Z in repo', created_at: iso(0) }),
  chunk('w1', '[obsidian] relationship-stuffs', { source_type: 'obsidian', created_at: iso(40) }),
  chunk('o1', 'missed-call/Unknown/2026-10-01', { source_type: 'chat-export', created_at: iso(5) }),
];
const GROUND = [chunk('g1', 'pattern: groundwork export', { created_at: iso(1) })];

function fakeBrain() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const tools: BrainTools & { calls: typeof calls } = {
    calls,
    async callTool(name, args = {}) {
      calls.push([name, args]);
      if (name === 'stats') {
        return text({ total: 7, by_tier: { working: 7 }, by_workspace: { general: 6, 'groundwork-ai': 1, empty: 0 } });
      }
      if (name === 'get_chunks') return text(args.workspace === 'general' ? GENERAL : GROUND);
      if (name === 'search') return text({ chunks: [GENERAL[2]] });
      if (name === 'ingest') return text({ chunk_id: `new-${calls.filter(([n]) => n === 'ingest').length}` });
      return text({ ok: true });
    },
  };
  return tools;
}

function memoryStore(initial: HiddenRecord[] = []): HiddenStore & { saved: HiddenRecord[] } {
  const store = {
    saved: initial,
    load: async () => store.saved,
    save: async (records: HiddenRecord[]) => {
      store.saved = records;
    },
  };
  return store;
}

describe('parseToolResult', () => {
  it('reads JSON text content and tolerates plain values', () => {
    expect(parseToolResult(text({ a: 1 }))).toEqual({ a: 1 });
    expect(parseToolResult({ content: [{ type: 'text', text: 'not json' }] })).toBe('not json');
    expect(parseToolResult([1])).toEqual([1]);
  });
});

describe('classifyChunk', () => {
  const c = (title: string | null, over: Chunk = {}) =>
    classifyChunk({ title, content: '', source_type: 'paste', ...over });

  it('maps the title prefixes the agents write with', () => {
    expect(c('deploy choice: X')).toBe('decision');
    expect(c('agent hire: Pre-Con Coordinator')).toBe('decision');
    expect(c('routine: nightly sync')).toBe('decision');
    expect(c('Decision: use Traefik')).toBe('decision');
    expect(c('hard rule: no friday deploys')).toBe('preference');
    expect(c('preference: tabs')).toBe('preference');
    expect(c('pattern: model migration')).toBe('pattern');
    expect(c('bug fix: acme')).toBe('pattern');
    expect(c('incident: dns')).toBe('pattern');
    expect(c('topology: qwen removed')).toBe('pattern');
    expect(c('session summary: wayland work')).toBe('session');
  });

  it('recognises session logs and heartbeats from content or title', () => {
    expect(c(null, { content: 'claude-code session ended 2026-09-05T10:30:27Z in x' })).toBe('session');
    expect(c('ISA heartbeat 2026-05-09 — idle')).toBe('session');
    expect(c('coo heartbeat: quiet')).toBe('session');
  });

  it('treats imported notes as wiki and everything else as observation', () => {
    expect(c('[obsidian] contractor-appointments', { source_type: 'obsidian' })).toBe('wiki');
    expect(c('AOAO sequence', { source_type: 'obsidian:Outreach/x.md' })).toBe('wiki');
    expect(c('Roadmap', { source_type: 'file' })).toBe('wiki');
    expect(c('[wiki] My note')).toBe('wiki');
    expect(c('missed-call/Unknown/1', { source_type: 'chat-export' })).toBe('observation');
    expect(c(null)).toBe('observation');
  });

  it('lets a category prefix outrank the source', () => {
    expect(c('pattern: from a file', { source_type: 'file' })).toBe('pattern');
  });
});

describe('chunkToEntry', () => {
  it('builds a brain-scoped entry with its category and tags', () => {
    const e = chunkToEntry(chunk('x', 'hard rule: no fridays') as never, 'general');
    expect(e).toMatchObject({
      type: 'preference',
      project: 'general',
      projectPath: 'brain://general',
      sourcePath: 'brain://general/x',
      promotionScore: 42,
      referencedBy: 3,
    });
    expect(e.tags).toContain('preference');
    expect(e.bodyPreview.length).toBeLessThanOrEqual(280);
  });
});

describe('BrainMemoryService', () => {
  it('lists every non-empty workspace newest first, without bodies', async () => {
    const brain = fakeBrain();
    const { entries, total } = await new BrainMemoryService(brain, memoryStore()).listEntries({});
    expect(total).toBe(7);
    expect(entries[0].id === 'd1' || entries[0].id === 's1').toBe(true);
    expect(entries.map((e) => e.id)).toContain('g1');
    expect('body' in entries[0]).toBe(false);
    expect(
      brain.calls
        .filter(([n]) => n === 'get_chunks')
        .map(([, a]) => a.workspace)
        .sort()
    ).toEqual(['general', 'groundwork-ai']);
    expect(brain.calls.find(([n]) => n === 'get_chunks')?.[1].limit).toBeGreaterThan(1000);
  });

  it('shares one load across calls', async () => {
    const brain = fakeBrain();
    const svc = new BrainMemoryService(brain, memoryStore());
    await Promise.all([svc.listEntries({}), svc.getStats(), svc.getProjects()]);
    expect(brain.calls.filter(([n]) => n === 'stats')).toHaveLength(1);
  });

  it('filters by category, workspace, time window and tag', async () => {
    const svc = new BrainMemoryService(fakeBrain(), memoryStore());
    expect((await svc.listEntries({ types: ['preference'] })).entries.map((e) => e.id)).toEqual(['r1']);
    expect((await svc.listEntries({ project: 'groundwork-ai' })).entries.map((e) => e.id)).toEqual(['g1']);
    expect((await svc.listEntries({ project: 'global', types: ['wiki'] })).entries.map((e) => e.id)).toEqual(['w1']);
    expect((await svc.listEntries({ timeWindow: '7d', types: ['wiki'] })).entries).toEqual([]);
    expect((await svc.listEntries({ tags: ['obsidian'] })).entries.map((e) => e.id)).toEqual(['w1']);
  });

  it('searches through the brain and also matches literal text', async () => {
    const brain = fakeBrain();
    const svc = new BrainMemoryService(brain, memoryStore());
    const res = await svc.listEntries({ project: 'general', search: 'acme' });
    expect(brain.calls.some(([n, a]) => n === 'search' && a.workspace === 'general' && a.query === 'acme')).toBe(true);
    expect(res.entries[0].id).toBe('p1');
    const literal = await svc.listEntries({ project: 'general', search: 'friday' });
    expect(literal.entries.map((e) => e.id)).toContain('r1');
  });

  it('computes stats from the categories: disjoint counts, deltas, sparkline, streak', async () => {
    const stats = await new BrainMemoryService(fakeBrain(), memoryStore()).getStats();
    expect(stats.total).toBe(7);
    expect(stats.typeCounts).toMatchObject({
      decision: 1,
      preference: 1,
      pattern: 2,
      session: 1,
      wiki: 1,
      observation: 1,
    });
    expect(Object.values(stats.typeCounts).reduce((a, b) => a + b, 0)).toBe(stats.total);
    expect(stats.decisions).toBe(1);
    expect(stats.wiki).toBe(1);
    expect(stats.sessions).toBe(1);
    expect(stats.projects).toBe(2);
    expect(stats.deltas.total7d).toBeGreaterThanOrEqual(5);
    expect(stats.sparkline).toHaveLength(7);
    expect(stats.sparkline.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5);
    expect(stats.streak.sessions).toBeGreaterThan(1);
    expect(stats.streak.lastActiveDayMs).toBeGreaterThan(0);
  });

  it('ranks workspaces and counts tags', async () => {
    const svc = new BrainMemoryService(fakeBrain(), memoryStore());
    const projects = await svc.getProjects();
    expect(projects[0]).toMatchObject({ basename: 'general', count: 6, isGlobalStore: true, path: 'brain://general' });
    const tags = await svc.getTags();
    expect(tags.find((t) => t.tag === 'pattern')?.count).toBe(2);
    expect((await svc.getTags('groundwork-ai')).map((t) => t.tag)).toContain('pattern');
  });

  it('opens a listed entry with its full body', async () => {
    const svc = new BrainMemoryService(fakeBrain(), memoryStore());
    expect((await svc.getEntry('r1'))?.body).toContain('body of r1');
    expect(await svc.getEntry('missing')).toBeNull();
  });

  it('saves a memory with the chosen category and refuses thin content', async () => {
    const brain = fakeBrain();
    const svc = new BrainMemoryService(brain, memoryStore());
    await expect(svc.quickAdd('too short', 'global', 'decision')).rejects.toThrow(/40 characters/);
    await svc.quickAdd('Always rebuild detached and tail the log, never block a tool call.', 'global', 'preference');
    const ingest = brain.calls.find(([n]) => n === 'ingest')?.[1];
    expect(ingest).toMatchObject({ workspace: 'general', source_type: 'paste' });
    expect(String(ingest?.title)).toMatch(/^preference: /);
    const saved = (await svc.listEntries({ types: ['preference'] })).entries.map((e) => e.id);
    expect(saved).toContain('new-1');
  });

  it('saves into a chosen workspace', async () => {
    const brain = fakeBrain();
    await new BrainMemoryService(brain, memoryStore()).quickAdd(
      'Groundwork exports should always include the cost summary sheet.',
      'project',
      'pattern',
      'brain://groundwork-ai'
    );
    expect(brain.calls.find(([n]) => n === 'ingest')?.[1]).toMatchObject({ workspace: 'groundwork-ai' });
  });

  it('edits by ingesting a new version, superseding the old, and hiding it', async () => {
    const brain = fakeBrain();
    const store = memoryStore();
    const svc = new BrainMemoryService(brain, store);
    await svc.listEntries({});
    const res = await svc.editEntry('r1', { summary: 'revised', type: 'decision', body: 'x'.repeat(60) });
    expect(res).toEqual({ ok: true, newId: 'new-1' });
    expect(String(brain.calls.find(([n]) => n === 'ingest')?.[1].title)).toBe('decision: revised');
    expect(brain.calls.find(([n]) => n === 'supersede')?.[1]).toMatchObject({
      old_chunk_id: 'r1',
      new_chunk_id: 'new-1',
    });
    expect(store.saved).toEqual([expect.objectContaining({ entryId: 'r1', kind: 'superseded' })]);
    const ids = (await svc.listEntries({})).entries.map((e) => e.id);
    expect(ids).toContain('new-1');
    expect(ids).not.toContain('r1');
    expect((await svc.listArchivedEntries()).length).toBe(0);
  });

  it('refuses edits that are too short or target an unknown memory', async () => {
    const svc = new BrainMemoryService(fakeBrain(), memoryStore());
    expect((await svc.editEntry('nope', { summary: 'x' })).ok).toBe(false);
    expect((await svc.editEntry('r1', { body: 'tiny' })).error).toMatch(/40 characters/);
  });

  it('archives (hides) a memory, lists it under Archived, and restores it', async () => {
    const store = memoryStore();
    const svc = new BrainMemoryService(fakeBrain(), store);
    const res = await svc.deleteEntry('p1');
    expect(res.ok).toBe(true);
    expect((await svc.listEntries({})).entries.map((e) => e.id)).not.toContain('p1');
    const archived = await svc.listArchivedEntries();
    expect(archived).toEqual([expect.objectContaining({ archiveId: res.archiveId, summary: 'bug fix: traefik acme' })]);
    expect((await svc.restoreArchivedEntry(res.archiveId!)).ok).toBe(true);
    expect((await svc.listEntries({})).entries.map((e) => e.id)).toContain('p1');
    expect((await svc.restoreArchivedEntry('missing')).ok).toBe(false);
  });

  it('keeps archived memories hidden across a fresh load', async () => {
    const store = memoryStore([
      { archiveId: 'a1', entryId: 'p1', kind: 'archived', summary: 's', sourcePath: 'x', archivedAt: 1 },
    ]);
    const svc = new BrainMemoryService(fakeBrain(), store);
    expect((await svc.listEntries({})).entries.map((e) => e.id)).not.toContain('p1');
  });

  it('saves dropped notes as wiki memories and rejects bad names', async () => {
    const brain = fakeBrain();
    const svc = new BrainMemoryService(brain, memoryStore());
    const res = await svc.ingestFiles([
      { name: 'meeting-notes.md', content: 'Notes from the kickoff meeting with the whole crew.' },
      { name: '../evil.md', content: 'x'.repeat(100) },
      { name: 'tiny.txt', content: 'short' },
    ]);
    expect(res.ingested).toBe(1);
    expect(res.errors).toHaveLength(2);
    expect(String(brain.calls.find(([n]) => n === 'ingest')?.[1].title)).toBe('[wiki] meeting-notes');
    expect((await svc.listEntries({ types: ['wiki'] })).entries.map((e) => e.id)).toContain('new-1');
  });

  it('notifies listeners after a write', async () => {
    const svc = new BrainMemoryService(fakeBrain(), memoryStore());
    await svc.listEntries({});
    const cb = vi.fn();
    svc.onIndexChange(cb);
    await svc.quickAdd('A decision that is long enough to be worth keeping in the brain.', 'global', 'decision');
    expect(cb).toHaveBeenCalled();
  });
});
