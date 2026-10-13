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
  removeLadderedSkillPlugin,
  sanitizeSkillMarkdown,
} from '@process/services/jarvis/ladderedSkillPlugin';
import { setupAssistantWorkspace } from '@process/utils/initAgent';

roots.base = fs.mkdtempSync(path.join(os.tmpdir(), 'laddered-skill-plugin-'));
const config = path.join(roots.base, 'config');
const pluginRoot = path.join(roots.base, 'plugins');

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

const noPrefs = { pinned: [], disabled: [], revision: 0 };

beforeEach(() => {
  fs.rmSync(config, { recursive: true, force: true });
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
  await removeLadderedSkillPlugin(pluginRoot);
  fs.rmSync(roots.base, { recursive: true, force: true });
});

async function build(extra: Partial<Parameters<typeof buildLadderedSkillPlugin>[0]> = {}) {
  return (await buildLadderedSkillPlugin({
    backend: 'claude',
    sessionKey: 'conv-1',
    rootDir: pluginRoot,
    enabledSkills: ['pdf', 'crew-core-brand-context', 'quarantined'],
    _skillsPreferences: noPrefs,
    _libraryEntries: [{ name: 'quarantined', security: { verdict: 'blocked' } }],
    ...extra,
  })) as string;
}

describe('buildLadderedSkillPlugin', () => {
  it('holds a manifest and exactly the bounded skills - nothing else', async () => {
    const dir = await build();
    expect(dir).toBe(path.join(pluginRoot, 'conv-1'));
    expect(fs.readdirSync(dir).toSorted()).toEqual(['.claude-plugin', 'skills']);
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

  it('only Claude gets a plugin', async () => {
    expect(await buildLadderedSkillPlugin({ backend: 'codex', sessionKey: 'c', rootDir: pluginRoot })).toBeUndefined();
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
