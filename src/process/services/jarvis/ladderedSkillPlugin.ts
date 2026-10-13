/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The assistant's skills for a LADDERED Claude session, delivered as a
 * Wayland-owned local plugin instead of through a Claude setting source.
 *
 * A laddered Claude session loads no setting sources (see
 * resolveLadderedSessionMeta), so it no longer discovers the skills Wayland
 * copies into the workspace's `.claude/skills` - those are only read through
 * the `project` source. The Claude Agent SDK's `plugins` option (forwarded by
 * the ACP bridge from `_meta.claudeCode.options`, like `settingSources`) loads
 * a local plugin directory as `--plugin-dir`, independent of setting sources.
 *
 * WHAT THE PLUGIN HOLDS. Exactly the bounded set setupAssistantWorkspace would
 * place (resolveBoundedSkillSet: _builtin + pinned + the assistant's
 * enabledSkills, minus disabled and `security.verdict === 'blocked'`), and
 * nothing else: a manifest with a name, version and description, and
 * `skills/`. No hooks, MCP servers, commands, agents, output styles or
 * settings - every plugin surface that could run code or grant permissions
 * is absent, and the SDK is told to skip MCP discovery for it as well.
 *
 * A skill's own SKILL.md frontmatter can ALSO carry hooks, `allowed-tools`
 * (tools usable without asking while the skill is active - i.e. past the
 * ladder's permission gate), `shell`, `agent`, `context` and MCP servers.
 * Only descriptive keys are kept (SKILL_FRONTMATTER_KEYS); a SKILL.md whose
 * frontmatter cannot be parsed drops the whole skill.
 *
 * WHERE IT LIVES. Under Wayland's data dir, never inside the agent's
 * workspace; rebuilt from scratch for every session and left read-only.
 */

import { getDataPath } from '@process/utils/utils';
import { resolveBoundedSkillSet, type BoundedSkillSetOptions } from '@process/utils/initAgent';
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

/** Plugin name; Claude namespaces its skills as `wayland-skills:<skill>`. */
export const LADDERED_SKILL_PLUGIN_NAME = 'wayland-skills';

/** SKILL.md frontmatter keys that describe a skill and grant nothing. */
export const SKILL_FRONTMATTER_KEYS = [
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'arguments',
  'version',
  'license',
  'disable-model-invocation',
  'user-invocable',
] as const;

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Root under which per-session plugin dirs are built. */
export function ladderedSkillPluginRoot(): string {
  return path.join(getDataPath(), 'laddered-skill-plugins');
}

/** The `_meta.claudeCode.options` entry that loads a built plugin dir. */
export function ladderedSkillPluginOption(pluginDir: string): {
  plugins: Array<{ type: 'local'; path: string; skipMcpDiscovery: true }>;
} {
  return { plugins: [{ type: 'local', path: pluginDir, skipMcpDiscovery: true }] };
}

/**
 * Build the plugin dir for one session and return its path, or `undefined`
 * when `backend` is not Claude. Any previous build under the same key is
 * removed first.
 */
export async function buildLadderedSkillPlugin(
  options: BoundedSkillSetOptions & {
    backend: string;
    /** Unique per live session, e.g. the conversation id (`.btw` for a /btw fork). */
    sessionKey: string;
    /** Test seam; defaults to ladderedSkillPluginRoot(). */
    rootDir?: string;
  }
): Promise<string | undefined> {
  if (options.backend !== 'claude') return undefined;
  const root = options.rootDir ?? ladderedSkillPluginRoot();
  const pluginDir = path.join(root, options.sessionKey.replace(/[^A-Za-z0-9._-]/g, '_'));
  await removeLadderedSkillPlugin(pluginDir);

  const libraryEntries = options._libraryEntries ?? (await loadLibraryEntries());
  const skills = await resolveBoundedSkillSet({ ...options, _libraryEntries: libraryEntries });

  await fs.mkdir(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        name: LADDERED_SKILL_PLUGIN_NAME,
        version: '1.0.0',
        description: "This assistant's Wayland skills (generated per session; skills only).",
      },
      null,
      2
    )}\n`
  );
  const skillsDir = path.join(pluginDir, 'skills');
  await fs.mkdir(skillsDir);

  for (const skill of skills) {
    // A name that is not a single path segment could escape skills/.
    if (!skill.name || skill.name === '.' || skill.name === '..' || /[\\/]/.test(skill.name)) continue;
    const target = path.join(skillsDir, skill.name);
    const source = await fs.stat(skill.sourceDir).catch((): undefined => undefined);
    if (!source?.isDirectory()) {
      console.warn(`[ladderedSkillPlugin] ${skill.label} directory not found: ${skill.sourceDir}`);
      continue;
    }
    const taken = await fs.lstat(target).then(
      () => true,
      () => false
    );
    if (taken) continue; // first source under this name wins, as in the workspace
    try {
      await copySkillTree(skill.sourceDir, target);
    } catch (error) {
      console.warn(`[ladderedSkillPlugin] dropped ${skill.label} ${skill.name}:`, error);
      await removeLadderedSkillPlugin(target);
    }
  }

  await makeReadOnly(pluginDir);
  return pluginDir;
}

/** Remove a plugin dir built by buildLadderedSkillPlugin (read-only dirs included). */
export async function removeLadderedSkillPlugin(dir: string): Promise<void> {
  await makeWritable(dir);
  await fs.rm(dir, { recursive: true, force: true });
}

async function loadLibraryEntries(): Promise<BoundedSkillSetOptions['_libraryEntries']> {
  try {
    const { SkillLibrary } = await import('@process/services/skills/SkillLibrary');
    return await SkillLibrary.getInstance().list();
  } catch {
    return [];
  }
}

/**
 * Copy a skill directory: regular files and directories only (a symlinked file
 * is copied as its content, a symlinked directory is skipped), and every
 * SKILL.md reduced to descriptive frontmatter.
 */
async function copySkillTree(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const target = await fs.stat(from).catch((): undefined => undefined);
      isDir = false;
      isFile = target?.isFile() ?? false;
    }
    if (isDir) {
      await copySkillTree(from, to);
    } else if (isFile) {
      if (entry.name.toLowerCase() === 'skill.md') {
        await fs.writeFile(to, sanitizeSkillMarkdown(await fs.readFile(from, 'utf8')));
      } else {
        await fs.copyFile(from, to);
      }
    }
  }
}

/**
 * SKILL.md with only SKILL_FRONTMATTER_KEYS left in its frontmatter. Throws
 * when the frontmatter is not a YAML mapping, so the skill is dropped.
 */
export function sanitizeSkillMarkdown(content: string): string {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return content;
  const parsed = yaml.load(match[1]);
  if (parsed === null || parsed === undefined) return content.slice(match[0].length);
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SKILL.md frontmatter is not a mapping');
  const kept: Record<string, unknown> = {};
  for (const key of SKILL_FRONTMATTER_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (isPlainValue(value)) kept[key] = value;
  }
  const body = content.slice(match[0].length);
  return Object.keys(kept).length > 0 ? `---\n${yaml.dump(kept, { lineWidth: -1 })}---\n${body}` : body;
}

function isPlainValue(value: unknown): boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Files 0444, directories 0555, bottom-up. */
async function makeReadOnly(target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(target)) await makeReadOnly(path.join(target, name));
    await fs.chmod(target, 0o555);
  } else if (stat.isFile()) {
    await fs.chmod(target, 0o444);
  }
}

/** Directories 0755 top-down so a read-only tree can be removed. Missing is fine. */
async function makeWritable(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch((): undefined => undefined);
  if (!stat?.isDirectory()) return;
  await fs.chmod(target, 0o755);
  for (const name of await fs.readdir(target)) await makeWritable(path.join(target, name));
}
