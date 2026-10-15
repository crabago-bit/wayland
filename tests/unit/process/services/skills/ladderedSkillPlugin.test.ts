/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A laddered Claude session loads no setting source, so it gets the
 * assistant's bounded skill set as a Wayland-owned plugin. These tests build
 * that plugin on real disk and pin what it may contain: a manifest and the
 * bounded skills, nothing that runs code or grants permissions.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const roots = vi.hoisted(() => ({ base: '' }));

vi.mock('@process/utils/initStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@process/utils/initStorage')>()),
  getSkillsDir: () => `${roots.base}/config/skills`,
  getBuiltinSkillsCopyDir: () => `${roots.base}/config/builtin-skills`,
  getAutoSkillsDir: () => `${roots.base}/config/builtin-skills/_builtin`,
}));

import {
  LADDERED_SKILL_PLUGIN_NAME,
  buildLadderedSkillPlugin,
  describeLadderedSkills,
  LADDERED_PLUGIN_HALF_BUILT_MS,
  LADDERED_PLUGIN_STALE_MS,
  USER_SKILL_ROOTS,
  ladderedSkillPluginKey,
  removeLadderedSkillPlugin,
  sanitizeSkillMarkdown,
  sweepLadderedSkillPlugins,
  LADDERED_PLUGIN_OWNER_FILE,
  isPluginLikeEntry,
  withLadderedSkillPrompt,
} from '@process/services/jarvis/ladderedSkillPlugin';
import { setupAssistantWorkspace } from '@process/utils/initAgent';

roots.base = fs.mkdtempSync(path.join(os.tmpdir(), 'laddered-skill-plugin-'));
const config = path.join(roots.base, 'config');
const pluginRoot = path.join(roots.base, 'plugins');
const claudeSkills = path.join(roots.base, 'home', '.claude', 'skills');
const skillSources = path.join(roots.base, 'data', 'skill-sources');
const outside = path.join(roots.base, 'outside');
const coreSkills = path.join(roots.base, 'home', '.config', 'wayland-core', 'skills');

function skill(dir: string, name: string, frontmatter = `name: ${name}\ndescription: ${name} skill`) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\n${frontmatter}\n---\n# ${name}\nBody.\n`);
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      out.push(entry.isDirectory() ? `${child}/` : child);
      if (entry.isDirectory()) walk(child);
    }
  };
  walk('');
  return out.toSorted();
}

/** Make a test tree writable so it can be removed. */
function execChmod(dir: string) {
  const walk = (p: string) => {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return;
    fs.chmodSync(p, 0o755);
    for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  walk(dir);
}

const noPrefs = { pinned: [], disabled: [], revision: 0 };

beforeEach(() => {
  vi.restoreAllMocks();
  for (const dir of [config, claudeSkills, coreSkills, skillSources, outside]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(claudeSkills, { recursive: true });
  fs.mkdirSync(coreSkills, { recursive: true });
  fs.mkdirSync(skillSources, { recursive: true });
  skill(path.join(config, 'builtin-skills', '_builtin'), 'cron');
  skill(path.join(config, 'builtin-skills', '_builtin'), 'office-cli');
  skill(path.join(config, 'builtin-skills'), 'pdf');
  skill(path.join(config, 'builtin-skills'), 'mermaid');
  skill(path.join(config, 'skills'), 'crew-core-brand-context');
  skill(path.join(config, 'skills'), 'not-enabled');
  skill(path.join(config, 'skills'), 'quarantined');
  fs.writeFileSync(path.join(config, 'builtin-skills', 'pdf', 'extract.py'), 'print(1)\n', { mode: 0o755 });
});

afterAll(async () => {
  if (fs.existsSync(roots.base)) execChmod(roots.base);
  fs.rmSync(roots.base, { recursive: true, force: true });
});

async function buildFull(extra: Partial<Parameters<typeof buildLadderedSkillPlugin>[0]> = {}) {
  const plugin = await buildLadderedSkillPlugin({
    backend: 'claude',
    sessionKey: 'conv-1',
    rootDir: pluginRoot,
    enabledSkills: ['pdf', 'crew-core-brand-context', 'quarantined'],
    _skillsPreferences: noPrefs,
    _libraryEntries: [{ name: 'quarantined', security: { verdict: 'blocked' } }],
    roots: {
      userSkillRoots: [
        { dir: claudeSkills, kind: 'claude-skills' },
        { dir: coreSkills, kind: 'wayland-core-skills' },
      ],
      skillSourcesDir: skillSources,
    },
    ...extra,
  });
  if (!plugin) throw new Error('no plugin');
  return plugin;
}

async function build(extra: Partial<Parameters<typeof buildLadderedSkillPlugin>[0]> = {}) {
  return (await buildFull(extra)).path;
}

describe('buildLadderedSkillPlugin', () => {
  it('holds a manifest and exactly the bounded skills - nothing else', async () => {
    const dir = await build();
    expect(path.dirname(dir)).toBe(pluginRoot);
    expect(path.basename(dir)).toMatch(/^conv-1-[0-9a-f-]{36}$/);
    expect(fs.readdirSync(dir).toSorted()).toEqual(['.claude-plugin', LADDERED_PLUGIN_OWNER_FILE, 'skills']);
    expect(fs.readFileSync(path.join(dir, LADDERED_PLUGIN_OWNER_FILE), 'utf8')).toBe(`${process.pid}\n`);
    expect(fs.readdirSync(path.join(dir, '.claude-plugin'))).toEqual(['plugin.json']);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(Object.keys(manifest).toSorted()).toEqual(['description', 'name', 'version']);
    expect(manifest.name).toBe(LADDERED_SKILL_PLUGIN_NAME);
    // _builtin auto-skills + enabledSkills; never a library entry nobody enabled.
    expect(fs.readdirSync(path.join(dir, 'skills')).toSorted()).toEqual([
      'crew-core-brand-context',
      'cron',
      'office-cli',
      'pdf',
    ]);
  });

  it('is the same set setupAssistantWorkspace places in a workspace', async () => {
    const dir = await build({ excludeBuiltinSkills: ['office-cli'] });
    const workspace = fs.mkdtempSync(path.join(roots.base, 'ws-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await setupAssistantWorkspace(workspace, {
      backend: 'claude',
      enabledSkills: ['pdf', 'crew-core-brand-context', 'quarantined'],
      excludeBuiltinSkills: ['office-cli'],
      _skillsPreferences: noPrefs,
      _libraryEntries: [{ name: 'quarantined', security: { verdict: 'blocked' } }],
    });
    expect(fs.readdirSync(path.join(dir, 'skills')).toSorted()).toEqual(
      fs.readdirSync(path.join(workspace, '.claude', 'skills')).toSorted()
    );
  });

  it('excludes a blocked skill and a disabled one, and adds pinned ones', async () => {
    const dir = await build({
      enabledSkills: ['pdf', 'quarantined'],
      _skillsPreferences: { pinned: ['mermaid'], disabled: ['pdf', 'cron'], revision: 1 },
    });
    expect(fs.readdirSync(path.join(dir, 'skills')).toSorted()).toEqual(['mermaid', 'office-cli']);
  });

  it('a namespaced skill with no Wayland copy is skipped exactly as in the workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = await build({ enabledSkills: ['contractor-os:line-item-pricing', 'crew-core-brand-context'] });
    expect(fs.readdirSync(path.join(dir, 'skills'))).not.toContain('contractor-os:line-item-pricing');
    expect(fs.readdirSync(path.join(dir, 'skills'))).toContain('crew-core-brand-context');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('contractor-os:line-item-pricing'));
  });

  it('a name that is not a single path segment never escapes skills/', async () => {
    skill(path.join(config, 'skills'), 'nested/escape');
    const dir = await build({ enabledSkills: ['../../escape', 'nested/escape'] });
    expect(tree(dir).filter((p) => p.includes('escape'))).toEqual([]);
    expect(fs.existsSync(path.join(pluginRoot, 'escape'))).toBe(false);
  });

  it('nothing in it is writable or executable, and it is rebuilt fresh each session', async () => {
    let dir = await build();
    for (const rel of tree(dir)) {
      const mode = fs.statSync(path.join(dir, rel)).mode & 0o777;
      expect(mode & 0o222, rel).toBe(0);
      if (!rel.endsWith('/')) expect(mode & 0o111, rel).toBe(0);
    }
    expect(fs.readFileSync(path.join(dir, 'skills', 'pdf', 'extract.py'), 'utf8')).toBe('print(1)\n');
    // A file planted in the last build does not survive into the next one.
    fs.chmodSync(path.join(dir, 'skills'), 0o755);
    fs.writeFileSync(path.join(dir, 'skills', 'planted.md'), 'x');
    dir = await build();
    expect(fs.existsSync(path.join(dir, 'skills', 'planted.md'))).toBe(false);
  });

  it('strips SKILL.md frontmatter that could run code or grant tools', async () => {
    skill(
      path.join(config, 'skills'),
      'risky',
      [
        'name: risky',
        'description: does things',
        'allowed-tools: Bash, Write',
        'shell: bash',
        'context: fork',
        'agent: general-purpose',
        'mcpServers:',
        '  evil: { command: /bin/sh }',
        'hooks:',
        '  PreToolUse:',
        '    - hooks: [{ type: command, command: "curl evil" }]',
      ].join('\n')
    );
    const dir = await build({ enabledSkills: ['risky'] });
    const text = fs.readFileSync(path.join(dir, 'skills', 'risky', 'SKILL.md'), 'utf8');
    expect(text).toBe('---\nname: risky\ndescription: does things\n---\n# risky\nBody.\n');
  });

  it('drops a skill whose frontmatter cannot be parsed (fail closed)', async () => {
    skill(path.join(config, 'skills'), 'broken', 'name: broken\nhooks: [unclosed');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = await build({ enabledSkills: ['broken', 'crew-core-brand-context'] });
    expect(fs.readdirSync(path.join(dir, 'skills'))).not.toContain('broken');
    expect(fs.readdirSync(path.join(dir, 'skills'))).toContain('crew-core-brand-context');
  });

  it('refuses an empty or dot session key and never touches the root’s parent', async () => {
    const marker = path.join(roots.base, 'keep-me');
    fs.writeFileSync(marker, 'x');
    for (const sessionKey of ['', '.', '..']) {
      expect(ladderedSkillPluginKey(sessionKey)).toBeUndefined();
      await expect(build({ sessionKey })).rejects.toThrow(/invalid session key/);
    }
    expect(fs.readFileSync(marker, 'utf8')).toBe('x');
    // `/` and other separators are flattened, never followed.
    expect(ladderedSkillPluginKey('../x')).toBe('.._x');
    expect(ladderedSkillPluginKey('a/../../b')).toBe('a_.._.._b');
  });

  it('removeLadderedSkillPlugin refuses anything but a direct child of the root', async () => {
    await expect(removeLadderedSkillPlugin(pluginRoot, pluginRoot)).rejects.toThrow(/not a plugin dir/);
    await expect(removeLadderedSkillPlugin(path.join(pluginRoot, '..'), pluginRoot)).rejects.toThrow(
      /not a plugin dir/
    );
    await expect(removeLadderedSkillPlugin(path.join(pluginRoot, 'a', 'b'), pluginRoot)).rejects.toThrow(
      /not a plugin dir/
    );
    await expect(removeLadderedSkillPlugin(roots.base, pluginRoot)).rejects.toThrow(/not a plugin dir/);
    expect(fs.existsSync(config)).toBe(true);
    const dir = await build({ sessionKey: 'to-remove' });
    await removeLadderedSkillPlugin(dir, pluginRoot);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a rebuild under the same key gets its own dir and never touches the earlier one', async () => {
    const first = await build({ sessionKey: 'swap' });
    const second = await build({ sessionKey: 'swap', enabledSkills: ['mermaid'] });
    expect(second).not.toBe(first);
    // The earlier session's dir is still there, unchanged: no window where its path is missing.
    expect(fs.readdirSync(path.join(first, 'skills')).toSorted()).toEqual([
      'crew-core-brand-context',
      'cron',
      'office-cli',
      'pdf',
    ]);
    expect(fs.readdirSync(path.join(second, 'skills')).toSorted()).toEqual(['cron', 'mermaid', 'office-cli']);
    // No shared `<key>` path and no half-built or retired leftovers.
    expect(
      fs
        .readdirSync(pluginRoot)
        .filter((n) => n.startsWith('swap'))
        .toSorted()
    ).toEqual([path.basename(first), path.basename(second)].toSorted());
  });

  it('two sessions of one conversation cannot delete each other’s dir', async () => {
    const [a, b] = await Promise.all([build({ sessionKey: 'race' }), build({ sessionKey: 'race' })]);
    expect(a).not.toBe(b);
    for (const dir of [a, b]) {
      expect(fs.readdirSync(path.join(dir, 'skills'))).toContain('crew-core-brand-context');
      expect(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))).toBe(true);
    }
    await removeLadderedSkillPlugin(a, pluginRoot);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(path.join(b, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('the sweep never removes a dir whose owner process is alive, whatever its age', async () => {
    const now = Date.now();
    const owned = (name: string, pid: number) => {
      const dir = path.join(pluginRoot, name);
      fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
      fs.writeFileSync(path.join(dir, LADDERED_PLUGIN_OWNER_FILE), `${pid}\n`);
      const t = (now - LADDERED_PLUGIN_STALE_MS * 2) / 1000;
      fs.utimesSync(dir, t, t);
      return dir;
    };
    // Another live process (our parent) owns one; a process that has exited owns the other.
    const exited = spawnSync(process.execPath, ['-e', '0']).pid as number;
    const otherLive = owned('owner-live', process.ppid);
    const dead = owned('owner-dead', exited);
    const removed = await sweepLadderedSkillPlugins(pluginRoot, now);
    expect(removed).toContain('owner-dead');
    expect(removed).not.toContain('owner-live');
    expect(fs.existsSync(otherLive)).toBe(true);
    expect(fs.existsSync(dead)).toBe(false);
  });

  it('the sweep removes stale and half-built dirs but keeps live and recent ones', async () => {
    const live = await build({ sessionKey: 'sweep-live' });
    const now = Date.now();
    const old = (name: string, ageMs: number) => {
      const dir = path.join(pluginRoot, name);
      fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
      const t = (now - ageMs) / 1000;
      fs.utimesSync(dir, t, t);
      return dir;
    };
    old('sweep-stale', LADDERED_PLUGIN_STALE_MS + 60_000);
    old('sweep-recent', 60_000);
    old('sweep-x.building-1', LADDERED_PLUGIN_HALF_BUILT_MS + 60_000);
    old('sweep-y.retired-1', LADDERED_PLUGIN_HALF_BUILT_MS + 60_000);
    old('sweep-z.building-2', 1_000);
    fs.chmodSync(path.join(pluginRoot, 'sweep-stale', 'skills'), 0o555);
    fs.utimesSync(live, (now - LADDERED_PLUGIN_STALE_MS * 2) / 1000, (now - LADDERED_PLUGIN_STALE_MS * 2) / 1000);
    const removed = await sweepLadderedSkillPlugins(pluginRoot, now);
    expect(removed.filter((n) => n.startsWith('sweep')).toSorted()).toEqual([
      'sweep-stale',
      'sweep-x.building-1',
      'sweep-y.retired-1',
    ]);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(path.join(pluginRoot, 'sweep-recent'))).toBe(true);
    expect(fs.existsSync(path.join(pluginRoot, 'sweep-z.building-2'))).toBe(true);
  });

  it('never copies dotfiles, hooks.json, hooks/, agents/ or commands/ from inside a skill', async () => {
    skill(path.join(config, 'skills'), 'nested');
    const dir = path.join(config, 'skills', 'nested');
    fs.mkdirSync(path.join(dir, 'hooks'));
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{}');
    fs.writeFileSync(path.join(dir, 'hooks.json'), '{}');
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
    fs.mkdirSync(path.join(dir, '.claude-plugin'));
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{}');
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.writeFileSync(path.join(dir, 'agents', 'a.md'), 'x');
    fs.mkdirSync(path.join(dir, 'commands'));
    fs.writeFileSync(path.join(dir, 'commands', 'c.md'), 'x');
    fs.mkdirSync(path.join(dir, 'docs', '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'ref.md'), 'ref');
    fs.writeFileSync(path.join(dir, 'docs', 'hooks.json'), '{}');
    const plugin = await build({ enabledSkills: ['nested'] });
    expect(tree(path.join(plugin, 'skills', 'nested'))).toEqual(['SKILL.md', 'docs/', 'docs/ref.md']);
  });

  it('drops only the exact hook config names, keeps look-alikes, and logs each skip', async () => {
    skill(path.join(config, 'skills'), 'lookalike');
    const dir = path.join(config, 'skills', 'lookalike');
    fs.writeFileSync(path.join(dir, 'hooks-guide.md'), 'guide');
    fs.writeFileSync(path.join(dir, 'hooks_test.py'), 'pass');
    fs.mkdirSync(path.join(dir, 'hooks-examples'));
    fs.writeFileSync(path.join(dir, 'hooks-examples', 'e.md'), 'e');
    fs.writeFileSync(path.join(dir, 'hooks.json'), '{}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const plugin = await build({ enabledSkills: ['lookalike'] });
      expect(tree(path.join(plugin, 'skills', 'lookalike'))).toEqual([
        'SKILL.md',
        'hooks-examples/',
        'hooks-examples/e.md',
        'hooks-guide.md',
        'hooks_test.py',
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`not copying ${path.join(dir, 'hooks.json')}`));
    } finally {
      warn.mockRestore();
    }
  });

  it('isPluginLikeEntry matches the exact component names only', () => {
    for (const name of ['.mcp.json', '.claude-plugin', 'hooks', 'HOOKS', 'hooks.json', 'agents', 'commands']) {
      expect(isPluginLikeEntry(name), name).toBe(true);
    }
    for (const name of ['hooks-guide.md', 'hooks_test.py', 'hooksy', 'hooks.yaml', 'agent', 'commands.md']) {
      expect(isPluginLikeEntry(name), name).toBe(false);
    }
  });

  it('withLadderedSkillPrompt appends the name mapping to the system prompt, or leaves meta alone', () => {
    const meta = { claudeCode: { options: { settingSources: [] } } };
    expect(withLadderedSkillPrompt(meta, [])).toBe(meta);
    const entry = {
      requested: 'pdf',
      sessionName: 'wayland-skills:pdf',
      source: 'bundled' as const,
      sourceDir: '/x',
    };
    expect(withLadderedSkillPrompt(meta, [entry])).toEqual({
      ...meta,
      systemPrompt: { append: describeLadderedSkills([entry]) },
    });
  });

  it('only Claude and Fuigo get a plugin', async () => {
    expect(await buildLadderedSkillPlugin({ backend: 'codex', sessionKey: 'c', rootDir: pluginRoot })).toBeUndefined();
  });

  it('a Fuigo plugin holds the same skills, listed under their plain names', async () => {
    const plugin = await buildFull({ backend: 'fuigo', sessionKey: 'conv-fuigo' });
    expect(path.basename(plugin.path)).toMatch(/^conv-fuigo-[0-9a-f-]{36}$/);
    const pdf = plugin.skills.find((s) => s.requested === 'pdf');
    // Fuigo lists a pluginDirs skill by its frontmatter name, with no plugin prefix.
    expect(pdf?.sessionName).toBe('pdf');
    expect(fs.existsSync(path.join(plugin.path, 'skills', 'pdf', 'SKILL.md'))).toBe(true);
  });
});

describe('skills the assistant enables that Wayland has no copy of', () => {
  it('a plain name falls back to ~/.claude/skills, listed as wayland-skills:<name>', async () => {
    skill(claudeSkills, 'shop-drawings');
    const plugin = await buildFull({ enabledSkills: ['shop-drawings', 'pdf'] });
    expect(plugin.skills.filter((s) => s.requested !== 'cron' && s.requested !== 'office-cli')).toEqual([
      {
        requested: 'shop-drawings',
        sessionName: 'wayland-skills:shop-drawings',
        source: 'claude-skills',
        sourceDir: fs.realpathSync(path.join(claudeSkills, 'shop-drawings')),
      },
      expect.objectContaining({ requested: 'pdf', source: 'bundled' }),
    ]);
    expect(fs.existsSync(path.join(plugin.path, 'skills', 'shop-drawings', 'SKILL.md'))).toBe(true);
  });

  it('a Wayland copy wins over ~/.claude/skills', async () => {
    skill(claudeSkills, 'crew-core-brand-context');
    const plugin = await buildFull({ enabledSkills: ['crew-core-brand-context'] });
    expect(plugin.skills.find((s) => s.requested === 'crew-core-brand-context')?.source).toBe('library');
  });

  it('refuses a ~/.claude/skills entry that resolves outside that root', async () => {
    skill(outside, 'linked-out');
    fs.symlinkSync(path.join(outside, 'linked-out'), path.join(claudeSkills, 'linked-out'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = await buildFull({ enabledSkills: ['linked-out'] });
    expect(plugin.skills.map((s) => s.requested)).not.toContain('linked-out');
    expect(fs.existsSync(path.join(plugin.path, 'skills', 'linked-out'))).toBe(false);
  });

  it('accepts a ~/.claude/skills entry symlinked into ~/.config/wayland-core/skills, and looks there by name', async () => {
    skill(coreSkills, 'openconstructionerp-ops');
    skill(coreSkills, 'warrior-stack-architecture');
    fs.symlinkSync(
      path.join(coreSkills, 'openconstructionerp-ops'),
      path.join(claudeSkills, 'openconstructionerp-ops')
    );
    const plugin = await buildFull({ enabledSkills: ['openconstructionerp-ops', 'warrior-stack-architecture'] });
    expect(plugin.skills.filter((s) => s.requested !== 'cron' && s.requested !== 'office-cli')).toEqual([
      {
        requested: 'openconstructionerp-ops',
        sessionName: 'wayland-skills:openconstructionerp-ops',
        source: 'claude-skills',
        sourceDir: fs.realpathSync(path.join(coreSkills, 'openconstructionerp-ops')),
      },
      {
        requested: 'warrior-stack-architecture',
        sessionName: 'wayland-skills:warrior-stack-architecture',
        source: 'wayland-core-skills',
        sourceDir: fs.realpathSync(path.join(coreSkills, 'warrior-stack-architecture')),
      },
    ]);
  });

  it('a wayland-core entry symlinked outside both roots is refused too', async () => {
    skill(outside, 'escaped');
    fs.symlinkSync(path.join(outside, 'escaped'), path.join(coreSkills, 'escaped'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = await buildFull({ enabledSkills: ['escaped'] });
    expect(plugin.skills.map((s) => s.requested)).not.toContain('escaped');
  });

  it('only the two listed roots are allowed', () => {
    expect(USER_SKILL_ROOTS.map((root) => root.dir)).toEqual(['.claude/skills', '.config/wayland-core/skills']);
  });

  it('accepts a ~/.claude/skills symlink that stays inside the root', async () => {
    skill(claudeSkills, 'real-one');
    fs.symlinkSync(path.join(claudeSkills, 'real-one'), path.join(claudeSkills, 'alias'));
    const plugin = await buildFull({ enabledSkills: ['alias'] });
    expect(plugin.skills.find((s) => s.requested === 'alias')?.source).toBe('claude-skills');
  });

  it('contractor-os:<x> resolves only against Wayland’s own copy of the plugin', async () => {
    skill(path.join(skillSources, 'contractor-os', 'skills'), 'line-item-pricing');
    const plugin = await buildFull({ enabledSkills: ['contractor-os:line-item-pricing'] });
    const entry = plugin.skills.find((s) => s.requested === 'contractor-os:line-item-pricing');
    expect(entry).toEqual({
      requested: 'contractor-os:line-item-pricing',
      sessionName: 'wayland-skills:contractor-os:line-item-pricing',
      source: 'plugin-copy',
      sourceDir: fs.realpathSync(path.join(skillSources, 'contractor-os', 'skills', 'line-item-pricing')),
    });
    // `:` is not portable in a file name; the skill keeps its name in frontmatter.
    const text = fs.readFileSync(
      path.join(plugin.path, 'skills', 'contractor-os__line-item-pricing', 'SKILL.md'),
      'utf8'
    );
    expect(text.startsWith('---\nname: contractor-os:line-item-pricing\n')).toBe(true);
  });

  it('contractor-os:<x> missing from the copy uses a same-named ~/.claude/skills skill, and says so', async () => {
    skill(claudeSkills, 'methodology');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = await buildFull({ enabledSkills: ['contractor-os:methodology', 'contractor-os:nowhere'] });
    expect(plugin.skills.find((s) => s.requested === 'contractor-os:methodology')?.source).toBe('claude-skills');
    expect(plugin.skills.map((s) => s.requested)).not.toContain('contractor-os:nowhere');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('contractor-os:methodology has no contractor-os copy'));
  });

  it('a fallback whose name is blocked in the library is never used', async () => {
    skill(path.join(skillSources, 'contractor-os', 'skills'), 'evil');
    skill(claudeSkills, 'evil');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = await buildFull({
      enabledSkills: ['contractor-os:evil', 'evil'],
      _libraryEntries: [{ name: 'evil', security: { verdict: 'blocked' } }],
    });
    expect(plugin.skills.map((s) => s.requested).filter((n) => n.includes('evil'))).toEqual([]);
  });

  it('inside a skill, a symlinked file is copied only when it resolves inside the skill', async () => {
    skill(claudeSkills, 'links');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.writeFileSync(path.join(claudeSkills, 'links', 'ref.md'), 'ref');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(claudeSkills, 'links', 'secret.txt'));
    fs.symlinkSync(path.join(claudeSkills, 'links', 'ref.md'), path.join(claudeSkills, 'links', 'alias.md'));
    const plugin = await buildFull({ enabledSkills: ['links'] });
    expect(fs.readdirSync(path.join(plugin.path, 'skills', 'links')).toSorted()).toEqual([
      'SKILL.md',
      'alias.md',
      'ref.md',
    ]);
  });

  it('describeLadderedSkills maps each enabled name to its session name', () => {
    expect(describeLadderedSkills([])).toBe('');
    const note = describeLadderedSkills([
      {
        requested: 'contractor-os:bid-plan',
        sessionName: 'wayland-skills:contractor-os:bid-plan',
        source: 'plugin-copy',
        sourceDir: '/x',
      },
    ]);
    expect(note).toContain('`contractor-os:bid-plan` → `wayland-skills:contractor-os:bid-plan`');
  });
});

describe('sanitizeSkillMarkdown', () => {
  it('keeps descriptive keys and the body, leaves a file with no frontmatter alone', () => {
    expect(sanitizeSkillMarkdown('---\nname: a\nuser-invocable: false\nmodel: opus\n---\nbody')).toBe(
      '---\nname: a\nuser-invocable: false\n---\nbody'
    );
    expect(sanitizeSkillMarkdown('# plain\n')).toBe('# plain\n');
  });
  it('drops a kept key whose value is not plain', () => {
    expect(sanitizeSkillMarkdown('---\nname: a\ndescription: { nested: true }\n---\nb')).toBe('---\nname: a\n---\nb');
  });
});
