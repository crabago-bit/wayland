/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * loadGlobalMemoryBlock builds the attributed, capped block of the user's curated brain
 * memories (preferences, decisions, patterns, wiki notes in the global workspace) that is
 * injected when a chat is created. These tests drive it through a fake brain memory service.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListFilter, MemoryEntry } from '@/common/types/memory';

vi.mock('@process/services/i18n', () => ({
  default: { t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key },
}));

const { getBrainMemory } = vi.hoisted(() => ({ getBrainMemory: vi.fn() }));
vi.mock('@process/services/memory/memoryBackend', () => ({ getBrainMemory }));

import { loadGlobalMemoryBlock } from '@process/services/projectKnowledge/knowledge';

function entry(id: string, summary: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    type: 'preference',
    project: 'general',
    projectPath: 'brain://general',
    summary,
    bodyPreview: '',
    tags: [],
    storedAt: Date.now(),
    sourcePath: `brain://general/${id}`,
    sourceLine: 0,
    referencedBy: 0,
    promotionScore: 0,
    ...over,
  };
}

function fakeBrain(entries: MemoryEntry[], bodies: Record<string, string> = {}) {
  const listEntries = vi.fn(async (_filter: ListFilter = {}) => ({ entries, total: entries.length }));
  return {
    listEntries,
    getEntry: vi.fn(async (id: string) => {
      const e = entries.find((x) => x.id === id);
      return e ? { ...e, body: bodies[id] ?? '' } : null;
    }),
  };
}

beforeEach(() => getBrainMemory.mockReset());

describe('loadGlobalMemoryBlock', () => {
  it('returns nothing when no brain is configured', async () => {
    getBrainMemory.mockResolvedValue(null);
    expect(await loadGlobalMemoryBlock()).toBe('');
  });

  it('returns nothing when the brain is unreachable or holds nothing curated', async () => {
    getBrainMemory.mockRejectedValueOnce(new Error('down'));
    expect(await loadGlobalMemoryBlock()).toBe('');
    getBrainMemory.mockResolvedValueOnce(fakeBrain([]));
    expect(await loadGlobalMemoryBlock()).toBe('');
    getBrainMemory.mockResolvedValueOnce({
      listEntries: async () => {
        throw new Error('boom');
      },
      getEntry: async () => null,
    });
    expect(await loadGlobalMemoryBlock()).toBe('');
  });

  it('asks only for curated categories in the global workspace, newest first', async () => {
    const brain = fakeBrain([entry('a', 'hard rule: never deploy on Friday')], { a: 'Ship Monday to Thursday only.' });
    getBrainMemory.mockResolvedValue(brain);
    await loadGlobalMemoryBlock();
    expect(brain.listEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'global',
        sort: 'recent',
        types: expect.arrayContaining(['preference', 'decision', 'pattern', 'wiki']),
      })
    );
    const types = (brain.listEntries.mock.calls[0]?.[0] as ListFilter).types ?? [];
    expect(types).not.toContain('session');
    expect(types).not.toContain('observation');
  });

  it('formats an attributed block with a heading and body per memory', async () => {
    getBrainMemory.mockResolvedValue(
      fakeBrain([entry('a', 'hard rule: never deploy on Friday'), entry('b', 'decision: use Traefik')], {
        a: 'Ship Monday to Thursday only.',
        b: 'Traefik routes every subdomain.',
      })
    );
    const block = await loadGlobalMemoryBlock();
    expect(block.startsWith('[User memory (from your brain)')).toBe(true);
    expect(block).toContain('## hard rule: never deploy on Friday\n\nShip Monday to Thursday only.');
    expect(block).toContain('## decision: use Traefik\n\nTraefik routes every subdomain.');
  });

  it('marks an empty body instead of dropping the entry', async () => {
    getBrainMemory.mockResolvedValue(fakeBrain([entry('a', 'preference: tabs')], { a: '' }));
    expect(await loadGlobalMemoryBlock()).toContain('…(entry body empty)');
  });

  it('truncates a very long body and says so', async () => {
    getBrainMemory.mockResolvedValue(fakeBrain([entry('a', 'pattern: long')], { a: 'x'.repeat(20_000) }));
    const block = await loadGlobalMemoryBlock();
    expect(block).toContain('…(truncated)');
    expect(block.length).toBeLessThan(10_000);
  });

  it('caps the entry count and discloses how many were left out', async () => {
    const many = Array.from({ length: 60 }, (_, i) => entry(`e${i}`, `decision: item ${i}`));
    const bodies = Object.fromEntries(many.map((e) => [e.id, 'short']));
    getBrainMemory.mockResolvedValue(fakeBrain(many, bodies));
    const block = await loadGlobalMemoryBlock();
    expect(block).toContain('## decision: item 0');
    expect(block).not.toContain('## decision: item 55');
    expect(block).toMatch(/…\(\d+ more memory entries omitted to fit the context budget\)/);
  });
});
