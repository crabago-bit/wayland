/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the drop-in assistant-pack loader (`@process/utils/userCatalog`).
 *
 * The behaviours that actually matter to a user are the version rules: an
 * assistant they edited must survive the next boot, and one they deleted must
 * not come back. Both are asserted end-to-end against a real temp packs dir.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AcpBackendConfig } from '@/common/types/acpTypes';
import type { AutonomyRung } from '@/common/jarvis/autonomy';
import {
  applyAssistantPacks,
  applyPackAutonomy,
  buildPackAssistant,
  buildPackTeam,
  formatPackSummary,
  packAssistantId,
  parseAssistantPack,
  reconcilePackAssistants,
  renderTeamTaskPrefill,
  type AssistantPack,
} from '@process/utils/userCatalog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PACK = {
  pack: 'warrior',
  version: 1,
  generatedAt: '2026-09-05T00:00:00.000Z',
  assistants: [
    {
      id: 'warrior-scout',
      name: 'Scout',
      description: 'Finds things.',
      avatar: '🔭',
      presetAgentType: 'claude',
      promptFile: 'warrior-scout.en-US.md',
      prompts: ['Go look.'],
      enabledSkills: ['deepsearch'],
      tier: 'jarvis-cheap',
      autonomyRung: 2,
      workspace: '/tmp/ws',
    },
    {
      id: 'warrior-editor',
      name: 'Editor',
      presetAgentType: 'claude',
      promptFile: 'warrior-editor.en-US.md',
      tier: 'jarvis-default',
      autonomyRung: 1,
    },
  ],
  teams: [
    {
      id: 'warrior-desk',
      name: 'Desk',
      workspace: '/tmp/ws',
      workspaceMode: 'shared',
      leader: 'warrior-editor',
      members: ['warrior-scout', 'warrior-editor'],
      tasks: [
        { subject: 'Survey', description: 'Collect.', owner: 'warrior-scout' },
        { subject: 'Cut', owner: 'warrior-editor', blockedBy: ['Survey'] },
      ],
    },
  ],
};

let dir: string;
let packsDir: string;
let assistantsDir: string;

/** Mutable in-memory config, mirroring the three keys the loader touches. */
type Store = {
  assistants: AcpBackendConfig[];
  applied: Record<string, number> | undefined;
  autonomy: Record<string, AutonomyRung> | undefined;
  logs: string[];
  warns: string[];
};

const makeStore = (): Store => ({ assistants: [], applied: undefined, autonomy: undefined, logs: [], warns: [] });

const io = (store: Store) => ({
  packsDir,
  assistantsDir,
  getAssistants: async () => store.assistants,
  setAssistants: async (next: AcpBackendConfig[]) => {
    store.assistants = next;
  },
  getApplied: async () => store.applied,
  setApplied: async (next: Record<string, number>) => {
    store.applied = next;
  },
  getAutonomy: async () => store.autonomy,
  setAutonomy: async (next: Record<string, AutonomyRung>) => {
    store.autonomy = next;
  },
  log: (line: string) => store.logs.push(line),
  warn: (line: string) => store.warns.push(line),
});

const writePack = async (pack: unknown, file = 'warrior.pack.json') =>
  writeFile(path.join(packsDir, file), typeof pack === 'string' ? pack : JSON.stringify(pack), 'utf-8');

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wayland-packs-'));
  packsDir = path.join(dir, 'assistant-packs');
  assistantsDir = path.join(dir, 'assistants');
  await mkdir(packsDir, { recursive: true });
  await writeFile(path.join(packsDir, 'warrior-scout.en-US.md'), '# Scout\n', 'utf-8');
  await writeFile(path.join(packsDir, 'warrior-editor.en-US.md'), '# Editor\n', 'utf-8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseAssistantPack
// ---------------------------------------------------------------------------

describe('parseAssistantPack', () => {
  it('rejects malformed JSON without throwing', () => {
    const result = parseAssistantPack('{ not json');
    expect(result).toHaveProperty('error');
    expect('error' in result && result.error).toContain('invalid JSON');
  });

  it('rejects a pack with no name or a non-positive version', () => {
    expect(parseAssistantPack(JSON.stringify({ version: 1 }))).toHaveProperty('error');
    expect(parseAssistantPack(JSON.stringify({ pack: 'x', version: 0 }))).toHaveProperty('error');
    expect(parseAssistantPack(JSON.stringify({ pack: 'x', version: 1.5 }))).toHaveProperty('error');
    expect(parseAssistantPack(JSON.stringify({ pack: '../evil', version: 1 }))).toHaveProperty('error');
  });

  it('normalizes ids, prefixing bare ones and reusing already-prefixed ones', () => {
    const result = parseAssistantPack(
      JSON.stringify({
        pack: 'warrior',
        version: 1,
        assistants: [
          { id: 'scout', name: 'A' },
          { id: 'pack-warrior-editor', name: 'B' },
        ],
      })
    );
    expect('pack' in result && result.pack.assistants.map((a) => a.id)).toEqual([
      'pack-warrior-scout',
      'pack-warrior-editor',
    ]);
  });

  it('keeps the first of duplicate ids and drops rows missing id or name', () => {
    const result = parseAssistantPack(
      JSON.stringify({
        pack: 'warrior',
        version: 1,
        assistants: [
          { id: 'scout', name: 'First' },
          { id: 'scout', name: 'Second' },
          { id: 'pack-warrior-scout', name: 'Third' },
          { id: 'nameless' },
          { name: 'idless' },
        ],
      })
    );
    expect('pack' in result && result.pack.assistants).toHaveLength(1);
    expect('pack' in result && result.pack.assistants[0].name).toBe('First');
  });

  it('drops a promptFile that is not a plain file name', () => {
    const result = parseAssistantPack(
      JSON.stringify({
        pack: 'warrior',
        version: 1,
        assistants: [{ id: 'scout', name: 'A', promptFile: '../../etc/passwd' }],
      })
    );
    expect('pack' in result && result.pack.assistants[0].promptFile).toBeUndefined();
  });

  it('ignores an out-of-range autonomy rung', () => {
    const result = parseAssistantPack(
      JSON.stringify({ pack: 'w', version: 1, assistants: [{ id: 'a', name: 'A', autonomyRung: 9 }] })
    );
    expect('pack' in result && result.pack.assistants[0].autonomyRung).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

describe('row builders', () => {
  const pack = (parseAssistantPack(JSON.stringify(PACK)) as { pack: AssistantPack }).pack;

  it('builds an editable, enabled specialist preset', () => {
    const row = buildPackAssistant(pack, pack.assistants[0]);
    expect(row).toMatchObject({
      id: 'pack-warrior-scout',
      kind: 'specialist',
      category: 'warrior',
      isPreset: true,
      isBuiltin: false,
      enabled: true,
      enabledSkills: ['deepsearch'],
      packMeta: { pack: 'warrior', tier: 'jarvis-cheap', workspace: '/tmp/ws' },
    });
  });

  it('puts the leader first in the team roster and renders the task chain', () => {
    const row = buildPackTeam(pack, pack.teams[0]);
    expect(row.kind).toBe('team');
    expect(row.teammates).toEqual(['pack-warrior-editor', 'pack-warrior-scout']);
    const prefill = row.kickoffs?.[0].prefill ?? '';
    expect(prefill).toContain('1. Survey');
    expect(prefill).toContain('2. Cut');
    expect(prefill).toContain('blocked by: Survey');
  });

  it('renders every task in order with its owner', () => {
    const prefill = renderTeamTaskPrefill(pack.teams[0]);
    expect(prefill.indexOf('Survey')).toBeLessThan(prefill.indexOf('Cut'));
    expect(prefill).toContain('[owner: pack-warrior-scout]');
  });
});

// ---------------------------------------------------------------------------
// Version semantics (pure)
// ---------------------------------------------------------------------------

describe('reconcilePackAssistants', () => {
  const row = (id: string, extra: Partial<AcpBackendConfig> = {}): AcpBackendConfig => ({
    id,
    name: id,
    isPreset: true,
    isBuiltin: false,
    ...extra,
  });

  it('inserts every row on a first application', () => {
    const result = reconcilePackAssistants([], [row('pack-w-a'), row('pack-w-b')], { packVersion: 1 });
    expect(result.added).toEqual(['pack-w-a', 'pack-w-b']);
    expect(result.changed).toBe(true);
  });

  it('does nothing at all when the pack version is not newer than the applied one', () => {
    const existing = [row('pack-w-a', { name: 'user renamed' })];
    const result = reconcilePackAssistants(existing, [row('pack-w-a'), row('pack-w-b')], {
      packVersion: 1,
      appliedVersion: 1,
    });
    expect(result.skipped).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.next).toBe(existing);
  });

  it('refreshes existing rows on a version bump but keeps the user enabled flag', () => {
    const existing = [row('pack-w-a', { name: 'user renamed', enabled: false })];
    const result = reconcilePackAssistants(existing, [row('pack-w-a', { name: 'v2 name', enabled: true })], {
      packVersion: 2,
      appliedVersion: 1,
    });
    expect(result.next[0].name).toBe('v2 name');
    expect(result.next[0].enabled).toBe(false);
  });

  it('never touches rows outside the pack', () => {
    const foreign = row('builtin-concierge');
    const result = reconcilePackAssistants([foreign], [row('pack-w-a')], { packVersion: 1 });
    expect(result.next[0]).toBe(foreign);
  });
});

describe('applyPackAutonomy', () => {
  it('fills only rungs that are not already stored', () => {
    const current = { 'custom:pack-w-a': 4 as AutonomyRung };
    const { next, changed } = applyPackAutonomy(current, [
      { id: 'pack-w-a', name: 'A', autonomyRung: 1 },
      { id: 'pack-w-b', name: 'B', autonomyRung: 2 },
      { id: 'pack-w-c', name: 'C' },
    ]);
    expect(next).toEqual({ 'custom:pack-w-a': 4, 'custom:pack-w-b': 2 });
    expect(changed).toBe(true);
  });
});

describe('formatPackSummary', () => {
  it('matches the documented boot line', () => {
    expect(formatPackSummary({ pack: 'warrior', version: 1, assistants: 12, teams: 1, added: 3, unchanged: 9 })).toBe(
      '[assistantPacks] warrior v1: 12 assistants, 1 team (3 new, 9 unchanged)'
    );
  });
});

describe('packAssistantId', () => {
  it('is idempotent for already-prefixed ids', () => {
    expect(packAssistantId('w', 'a')).toBe('pack-w-a');
    expect(packAssistantId('w', 'pack-w-a')).toBe('pack-w-a');
  });
});

// ---------------------------------------------------------------------------
// applyAssistantPacks (end to end against a temp dir)
// ---------------------------------------------------------------------------

describe('applyAssistantPacks', () => {
  it('creates the drop-in directory and returns nothing when it is empty', async () => {
    const store = makeStore();
    const emptyDir = path.join(dir, 'fresh-packs');
    const summaries = await applyAssistantPacks({ ...io(store), packsDir: emptyDir });
    expect(summaries).toEqual([]);
    await expect(readFile(path.join(emptyDir, 'nothing'), 'utf-8')).rejects.toThrow();
  });

  it('seeds assistants, the team launcher, prompts, autonomy and the applied version', async () => {
    const store = makeStore();
    await writePack(PACK);
    await applyAssistantPacks(io(store));

    expect(store.assistants.map((a) => a.id)).toEqual([
      'pack-warrior-scout',
      'pack-warrior-editor',
      'pack-warrior-desk',
    ]);
    expect(store.applied).toEqual({ warrior: 1 });
    expect(store.autonomy).toEqual({ 'custom:pack-warrior-scout': 2, 'custom:pack-warrior-editor': 1 });
    await expect(readFile(path.join(assistantsDir, 'pack-warrior-scout.en-US.md'), 'utf-8')).resolves.toContain(
      '# Scout'
    );
    expect(store.logs).toEqual(['[assistantPacks] warrior v1: 2 assistants, 1 team (3 new, 0 unchanged)']);
  });

  it('skips an assistant whose declared promptFile is missing, keeping the rest', async () => {
    const store = makeStore();
    await writePack({
      ...PACK,
      assistants: [{ ...PACK.assistants[0], promptFile: 'nope.md' }, PACK.assistants[1]],
    });
    await applyAssistantPacks(io(store));

    expect(store.assistants.map((a) => a.id)).not.toContain('pack-warrior-scout');
    expect(store.assistants.map((a) => a.id)).toContain('pack-warrior-editor');
    expect(store.warns.join('\n')).toContain('promptFile "nope.md" not readable');
  });

  it('warns and continues past a malformed pack file', async () => {
    const store = makeStore();
    await writePack('{ broken', 'broken.pack.json');
    await writePack(PACK);
    await applyAssistantPacks(io(store));

    expect(store.warns.join('\n')).toContain('broken.pack.json');
    expect(store.assistants).toHaveLength(3);
  });

  it('keeps a user edit across a same-version reboot', async () => {
    const store = makeStore();
    await writePack(PACK);
    await applyAssistantPacks(io(store));

    store.assistants = store.assistants.map((a) =>
      a.id === 'pack-warrior-scout' ? { ...a, name: 'My Scout', enabled: false } : a
    );
    await applyAssistantPacks(io(store));

    const scout = store.assistants.find((a) => a.id === 'pack-warrior-scout');
    expect(scout?.name).toBe('My Scout');
    expect(scout?.enabled).toBe(false);
    expect(store.logs.at(-1)).toBe('[assistantPacks] warrior v1: 2 assistants, 1 team (0 new, 3 unchanged)');
  });

  it('does not resurrect a deleted assistant at the same version', async () => {
    const store = makeStore();
    await writePack(PACK);
    await applyAssistantPacks(io(store));

    store.assistants = store.assistants.filter((a) => a.id !== 'pack-warrior-scout');
    await applyAssistantPacks(io(store));

    expect(store.assistants.map((a) => a.id)).not.toContain('pack-warrior-scout');
  });

  it('re-seeds a deleted assistant and refreshes edited ones once the version is bumped', async () => {
    const store = makeStore();
    await writePack(PACK);
    await applyAssistantPacks(io(store));

    store.assistants = store.assistants
      .filter((a) => a.id !== 'pack-warrior-scout')
      .map((a) => (a.id === 'pack-warrior-editor' ? { ...a, name: 'My Editor', enabled: false } : a));

    await writePack({ ...PACK, version: 2 });
    await applyAssistantPacks(io(store));

    expect(store.assistants.map((a) => a.id)).toContain('pack-warrior-scout');
    const editor = store.assistants.find((a) => a.id === 'pack-warrior-editor');
    expect(editor?.name).toBe('Editor');
    // The one thing a version bump still may not do is re-enable what the user turned off.
    expect(editor?.enabled).toBe(false);
    expect(store.applied).toEqual({ warrior: 2 });
  });

  it('leaves an already-set autonomy rung alone on a version bump', async () => {
    const store = makeStore();
    await writePack(PACK);
    await applyAssistantPacks(io(store));

    store.autonomy = { ...store.autonomy, 'custom:pack-warrior-scout': 4 };
    await writePack({ ...PACK, version: 2 });
    await applyAssistantPacks(io(store));

    expect(store.autonomy?.['custom:pack-warrior-scout']).toBe(4);
  });

  it('loads the shipped sample fixture pack', async () => {
    const store = makeStore();
    const summaries = await applyAssistantPacks({
      ...io(store),
      packsDir: path.resolve(__dirname, '../../../fixtures/assistant-packs'),
    });
    expect(summaries).toEqual([
      { pack: 'sample', version: 1, assistants: 2, teams: 1, added: 3, unchanged: 0, skipped: false },
    ]);
    expect(store.assistants.find((a) => a.id === 'pack-sample-desk')?.kind).toBe('team');
  });
});
