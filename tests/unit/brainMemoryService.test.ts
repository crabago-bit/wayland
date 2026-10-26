import { describe, expect, it, vi } from 'vitest';
import {
  BrainMemoryService,
  chunkToEntry,
  parseToolResult,
  type BrainTools,
} from '../../src/process/services/memory/brainMemoryService';

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const chunk = (id: string, tier: string, created: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `title ${id}`,
  content: `body of ${id} `.repeat(10),
  source_type: 'paste',
  tier,
  confidence: 0.42,
  access_count: 3,
  created_at: created,
  ...extra,
});

function fakeBrain(): BrainTools & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    async callTool(name, args = {}) {
      calls.push([name, args]);
      if (name === 'stats')
        return text({
          total: 5,
          by_tier: { working: 3, episodic: 1, semantic: 1, procedural: 0 },
          by_workspace: { general: 4, 'groundwork-ai': 1, empty: 0 },
        });
      if (name === 'get_chunks')
        return text(
          args.workspace === 'general'
            ? [chunk('a', 'working', '2026-10-01T00:00:00Z'), chunk('b', 'semantic', '2026-10-03T00:00:00Z')]
            : [chunk('c', 'episodic', '2026-10-02T00:00:00Z')]
        );
      if (name === 'search') return text({ chunks: [chunk('s', 'procedural', '2026-10-04T00:00:00Z')] });
      if (name === 'ingest') return text({ chunk_id: 'new-1' });
      return text({ ok: true });
    },
  };
}

describe('parseToolResult', () => {
  it('reads JSON text content and tolerates plain values', () => {
    expect(parseToolResult(text({ a: 1 }))).toEqual({ a: 1 });
    expect(parseToolResult({ content: [{ type: 'text', text: 'not json' }] })).toBe('not json');
    expect(parseToolResult([1])).toEqual([1]);
  });
});

describe('chunkToEntry', () => {
  it('maps tier to type and workspace to project', () => {
    const e = chunkToEntry(chunk('x', 'procedural', '2026-10-01T00:00:00Z'), 'general');
    expect(e).toMatchObject({
      type: 'pattern',
      project: 'general',
      projectPath: 'brain://general',
      promotionScore: 42,
      referencedBy: 3,
    });
    expect(e.tags).toEqual(['procedural', 'paste']);
    expect(e.bodyPreview.length).toBeLessThanOrEqual(280);
  });
});

describe('BrainMemoryService', () => {
  it('lists every non-empty workspace, newest first, without bodies', async () => {
    const brain = fakeBrain();
    const svc = new BrainMemoryService(brain);
    const { entries, total } = await svc.listEntries({});
    expect(total).toBe(3);
    expect(entries.map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect('body' in entries[0]).toBe(false);
    const asked = brain.calls.filter(([n]) => n === 'get_chunks').map(([, a]) => a.workspace);
    expect(asked.sort()).toEqual(['general', 'groundwork-ai']);
  });

  it('uses search for a query and filters by type', async () => {
    const brain = fakeBrain();
    const svc = new BrainMemoryService(brain);
    const res = await svc.listEntries({ project: 'general', search: 'router', types: ['pattern'] });
    expect(brain.calls.some(([n, a]) => n === 'search' && a.workspace === 'general' && a.query === 'router')).toBe(
      true
    );
    expect(res.entries.map((e) => e.id)).toEqual(['s']);
    expect((await svc.listEntries({ project: 'general', types: ['decision'] })).entries.map((e) => e.id)).toEqual([
      'b',
    ]);
  });

  it('opens a listed entry with its full body', async () => {
    const svc = new BrainMemoryService(fakeBrain());
    await svc.listEntries({});
    expect((await svc.getEntry('a'))?.body).toContain('body of a');
    expect(await svc.getEntry('missing')).toBeNull();
  });

  it('reports stats from the brain tiers', async () => {
    const stats = await new BrainMemoryService(fakeBrain()).getStats();
    expect(stats).toMatchObject({ total: 5, projects: 2, sessions: 1, decisions: 1 });
    expect(stats.typeCounts.observation).toBe(3);
  });

  it('saves a quick add to the brain and refuses thin content', async () => {
    const brain = fakeBrain();
    const svc = new BrainMemoryService(brain);
    await expect(svc.quickAdd('too short', 'global')).rejects.toThrow();
    await svc.quickAdd('A decision that is long enough to be worth keeping in the brain.', 'global');
    expect(brain.calls.find(([n]) => n === 'ingest')?.[1]).toMatchObject({
      workspace: 'general',
      source_type: 'paste',
    });
  });

  it('edits by ingesting a new chunk and superseding the old one', async () => {
    const brain = fakeBrain();
    const svc = new BrainMemoryService(brain);
    await svc.listEntries({});
    const res = await svc.editEntry('a', { summary: 'revised title' });
    expect(res).toEqual({ ok: true, newId: 'new-1' });
    expect(brain.calls.find(([n]) => n === 'supersede')?.[1]).toMatchObject({
      old_chunk_id: 'a',
      new_chunk_id: 'new-1',
    });
  });

  it('does not delete (append-only) and has no archive', async () => {
    const svc = new BrainMemoryService(fakeBrain());
    expect((await svc.deleteEntry('a')).ok).toBe(false);
    expect(await svc.listArchivedEntries()).toEqual([]);
  });

  it('notifies listeners after a write', async () => {
    const svc = new BrainMemoryService(fakeBrain());
    const cb = vi.fn();
    svc.onIndexChange(cb);
    await svc.quickAdd('A decision that is long enough to be worth keeping in the brain.', 'global');
    expect(cb).toHaveBeenCalled();
  });
});
