/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The assistant's skills for a LADDERED Claude or Fuigo session, delivered as a
 * Wayland-owned local plugin instead of through a Claude setting source.
 *
 * FUIGO. A laddered Fuigo session is spawned without folder trust (so the
 * workspace's own `.fuigo/config.toml` MCP servers and permission rules are
 * not loaded) and gets this same plugin as its ONLY `_meta.pluginDirs` entry,
 * replacing the `<workspace>/.wayland` staging: Fuigo loads a plugin dir at
 * CliOverride scope whatever the folder trust, and lists its skills by their
 * plain frontmatter name (no plugin prefix, measured on 1.0.19). The staged
 * copies keep frontmatter such as `allowed-tools`; these do not.
 *
 * A laddered Claude session loads no setting sources (see
 * resolveLadderedSessionMeta), so it no longer discovers the skills Wayland
 * copies into the workspace's `.claude/skills` (read through the `project`
 * source) nor the operator's `~/.claude/skills` (the `user` source). The
 * Claude Agent SDK's `plugins` option (forwarded by the ACP bridge from
 * `_meta.claudeCode.options`, like `settingSources`) loads a local plugin
 * directory as `--plugin-dir`, independent of setting sources.
 *
 * WHAT THE PLUGIN HOLDS. The bounded set setupAssistantWorkspace would place
 * (resolveBoundedSkillSet: _builtin + pinned + the assistant's enabledSkills,
 * minus disabled and `security.verdict === 'blocked'`), and nothing else: a
 * manifest with a name, version and description, and `skills/`. No hooks, MCP
 * servers, commands, agents, output styles or settings - every plugin surface
 * that could run code or grant permissions is absent, and the SDK is told to
 * skip MCP discovery for it as well.
 *
 * WHERE A SKILL COMES FROM (resolveLadderedSkillSource). Wayland's own copies
 * first. A skill the assistant enables that Wayland has no copy of - the pack
 * skills the `user` source used to provide - falls back to:
 *  - `<ns>:<x>` (e.g. `contractor-os:line-item-pricing`): the Wayland-owned
 *    copy of that plugin's skills at `<dataDir>/skill-sources/<ns>/skills/<x>`
 *    (see scripts/refresh-skill-source.mjs), else a same-named skill in the
 *    USER_SKILL_ROOTS (logged);
 *  - a plain name: `<root>/<name>` for each of USER_SKILL_ROOTS, in order.
 * A fallback must resolve (realpath) to a directory INSIDE one of the allowed
 * roots (realpath'd), so an entry symlinked anywhere else is refused, and its
 * name must not be blocked in the skill library.
 *
 * A skill's own SKILL.md frontmatter can ALSO carry hooks, `allowed-tools`
 * (tools usable without asking while the skill is active - i.e. past the
 * ladder's permission gate), `shell`, `agent`, `context` and MCP servers.
 * Only descriptive keys are kept (SKILL_FRONTMATTER_KEYS); a SKILL.md whose
 * frontmatter cannot be parsed drops the whole skill. Its `name` is set to the
 * name the assistant enabled, so the session sees `wayland-skills:<that name>`.
 * Inside a skill only regular files and directories are copied; a symlinked
 * file is copied only when it resolves inside the skill.
 *
 * Inside a skill, dotfiles, `hooks*`, `agents/` and `commands/` are not copied.
 *
 * WHERE IT LIVES. `<dataDir>/laddered-skill-plugins/<key>`, never inside the
 * agent's workspace; the key must be a single safe path segment and every
 * mkdir/chmod/rm is confined to direct children of that root. Rebuilt from
 * scratch for every session (in a sibling dir, then swapped in), left
 * read-only (files 0444 - so a skill's scripts are not directly executable),
 * removed when the session ends, and swept once per process for leftovers.
 */

import { getDataPath } from '@process/utils/utils';
import { getBuiltinSkillsCopyDir } from '@process/utils/initStorage';
import { resolveBoundedSkillSet, type BoundedSkillSetOptions, type BoundedSkillSource } from '@process/utils/initAgent';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

/** Plugin name; Claude namespaces its skills as `wayland-skills:<skill>`. */
export const LADDERED_SKILL_PLUGIN_NAME = 'wayland-skills';

/** Backends a laddered skill plugin is built for. */
export const LADDERED_SKILL_PLUGIN_BACKENDS: ReadonlySet<string> = new Set(['claude', 'fuigo']);

/** The name a backend lists a plugin skill under. Fuigo uses the bare frontmatter name. */
function pluginSessionName(backend: string, skillName: string): string {
  return backend === 'fuigo' ? skillName : `${LADDERED_SKILL_PLUGIN_NAME}:${skillName}`;
}

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

/** Where a plugin skill was copied from. */
export type LadderedSkillSourceKind =
  | 'builtin' // config/builtin-skills/_builtin
  | 'bundled' // config/builtin-skills/<name>
  | 'library' // config/skills/<name>
  | 'extra' // an extra skill path (cron job skills)
  | 'claude-skills' // ~/.claude/skills/<name>
  | 'wayland-core-skills' // ~/.config/wayland-core/skills/<name>
  | 'plugin-copy'; // <dataDir>/skill-sources/<ns>/skills/<x>

/** One skill in a built plugin. */
export type LadderedSkillEntry = {
  /** The name the assistant enabled (e.g. `contractor-os:line-item-pricing`). */
  requested: string;
  /** The name the Claude session lists it under. */
  sessionName: string;
  source: LadderedSkillSourceKind;
  sourceDir: string;
};

export type LadderedSkillPlugin = { path: string; skills: LadderedSkillEntry[] };

/**
 * The ONLY folders outside Wayland a laddered skill may come from, in lookup
 * order (relative to the home directory). A skill found in one may be a
 * symlink into another, never anywhere else.
 */
export const USER_SKILL_ROOTS = [
  { dir: '.claude/skills', kind: 'claude-skills' },
  { dir: '.config/wayland-core/skills', kind: 'wayland-core-skills' },
] as const satisfies ReadonlyArray<{ dir: string; kind: LadderedSkillSourceKind }>;

/** Roots the fallbacks resolve against (test seam). */
export type LadderedSkillRoots = {
  /** USER_SKILL_ROOTS as absolute paths, in lookup order. */
  userSkillRoots: ReadonlyArray<{ dir: string; kind: LadderedSkillSourceKind }>;
  /** `<dataDir>/skill-sources` */
  skillSourcesDir: string;
};

/** Root under which per-session plugin dirs are built. */
export function ladderedSkillPluginRoot(): string {
  return path.join(getDataPath(), 'laddered-skill-plugins');
}

/** Wayland-owned copies of third-party plugins' skills (`<ns>/skills/<x>`). */
export function skillSourcesRoot(): string {
  return path.join(getDataPath(), 'skill-sources');
}

function defaultRoots(): LadderedSkillRoots {
  return {
    userSkillRoots: USER_SKILL_ROOTS.map((root) => ({ dir: path.join(os.homedir(), root.dir), kind: root.kind })),
    skillSourcesDir: skillSourcesRoot(),
  };
}

/** The `_meta.claudeCode.options` entry that loads a built plugin dir. */
export function ladderedSkillPluginOption(pluginDir: string): {
  plugins: Array<{ type: 'local'; path: string; skipMcpDiscovery: true }>;
} {
  return { plugins: [{ type: 'local', path: pluginDir, skipMcpDiscovery: true }] };
}

/**
 * The mapping from each enabled skill name to the name the session lists it
 * under (the instructions name skills without the plugin prefix). Empty when
 * the plugin holds no skills.
 */
export function describeLadderedSkills(skills: readonly LadderedSkillEntry[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((skill) => `- \`${skill.requested}\` → \`${skill.sessionName}\``);
  return [
    '[Skills in this session]',
    'Your skills are loaded as a plugin. Invoke a skill your instructions name by its session name:',
    ...lines,
  ].join('\n');
}

/**
 * `meta` with the skill-name mapping appended to the Claude system prompt
 * (`_meta.systemPrompt.append`, which the ACP bridge reads on every
 * session/new, session/load and fork - so a resumed session is told too).
 */
export function withLadderedSkillPrompt(
  meta: Record<string, unknown>,
  skills: readonly LadderedSkillEntry[]
): Record<string, unknown> {
  const append = describeLadderedSkills(skills);
  return append ? { ...meta, systemPrompt: { append } } : meta;
}

/** Name markers of a build in progress and of a build being replaced. */
const BUILDING = '.building-';
const RETIRED = '.retired-';
/** A plugin dir untouched this long, with no live session, is swept. */
export const LADDERED_PLUGIN_STALE_MS = 24 * 60 * 60_000;
/** A half-built or retired dir this old is swept. */
export const LADDERED_PLUGIN_HALF_BUILT_MS = 10 * 60_000;

/** Plugin dirs this process handed to a live session. */
const liveDirs = new Set<string>();
/** One sweep per plugin root per process, before its first build. */
const sweeps = new Map<string, Promise<void>>();

/** The directory name for a session key, or `undefined` when it is not a safe single segment. */
export function ladderedSkillPluginKey(sessionKey: string): string | undefined {
  const key = sessionKey.replace(/[^A-Za-z0-9._-]/g, '_');
  return key && key !== '.' && key !== '..' ? key : undefined;
}

/** Throws unless `dir` is a DIRECT child of `root` (both resolved); returns it resolved. */
function assertPluginDir(root: string, dir: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(dir);
  if (resolved === resolvedRoot || path.dirname(resolved) !== resolvedRoot) {
    throw new Error(`[ladderedSkillPlugin] ${dir} is not a plugin dir under ${root}`);
  }
  return resolved;
}

/**
 * Build the plugin dir for one session, or `undefined` when `backend` is not
 * one of LADDERED_SKILL_PLUGIN_BACKENDS. The build is made in a sibling dir and swapped in, so a live session
 * reading the previous build under the same key never sees a gap.
 */
export async function buildLadderedSkillPlugin(
  options: BoundedSkillSetOptions & {
    backend: string;
    /** One key per live session: the conversation id, or a unique id for a /btw fork. */
    sessionKey: string;
    /** Test seam; defaults to ladderedSkillPluginRoot(). */
    rootDir?: string;
    /** Test seam; defaults to USER_SKILL_ROOTS and <dataDir>/skill-sources. */
    roots?: LadderedSkillRoots;
  }
): Promise<LadderedSkillPlugin | undefined> {
  if (!LADDERED_SKILL_PLUGIN_BACKENDS.has(options.backend)) return undefined;
  const key = ladderedSkillPluginKey(options.sessionKey);
  if (!key) throw new Error(`[ladderedSkillPlugin] invalid session key ${JSON.stringify(options.sessionKey)}`);
  const root = path.resolve(options.rootDir ?? ladderedSkillPluginRoot());
  const finalDir = assertPluginDir(root, path.join(root, key));
  const buildDir = assertPluginDir(root, path.join(root, `${key}${BUILDING}${randomUUID()}`));
  await fs.mkdir(root, { recursive: true });
  await sweepOnce(root);

  const libraryEntries = options._libraryEntries ?? (await loadLibraryEntries());
  const blocked = new Set(
    (libraryEntries ?? []).filter((entry) => entry.security?.verdict === 'blocked').map((entry) => entry.name)
  );
  const skills = await resolveBoundedSkillSet({ ...options, _libraryEntries: libraryEntries });
  const roots = options.roots ?? defaultRoots();

  const placed: LadderedSkillEntry[] = [];
  try {
    await fs.mkdir(path.join(buildDir, '.claude-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(buildDir, '.claude-plugin', 'plugin.json'),
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
    const skillsDir = path.join(buildDir, 'skills');
    await fs.mkdir(skillsDir);

    for (const skill of skills) {
      const dirName = pluginSkillDirName(skill.name);
      if (!dirName) continue;
      const target = path.join(skillsDir, dirName);
      const source = await resolveLadderedSkillSource(skill, roots, blocked);
      if (!source) {
        console.warn(`[ladderedSkillPlugin] ${skill.label} directory not found: ${skill.name}`);
        continue;
      }
      const taken = await fs.lstat(target).then(
        () => true,
        () => false
      );
      if (taken) continue; // first source under this name wins, as in the workspace
      try {
        await copySkillTree(source.dir, target, await fs.realpath(source.dir), skill.name);
        placed.push({
          requested: skill.name,
          sessionName: pluginSessionName(options.backend, skill.name),
          source: source.kind,
          sourceDir: source.dir,
        });
      } catch (error) {
        console.warn(`[ladderedSkillPlugin] dropped ${skill.label} ${skill.name}:`, error);
        await removeTree(target);
      }
    }
    await makeReadOnly(buildDir);
  } catch (error) {
    await removeTree(buildDir).catch(() => {});
    throw error;
  }

  const pluginPath = await swapIn(root, buildDir, finalDir, key);
  liveDirs.add(pluginPath);
  return { path: pluginPath, skills: placed };
}

/**
 * Move `buildDir` to `finalDir`: the previous build is renamed aside first and
 * removed after. If a concurrent build takes `finalDir` first (or the rename
 * is refused), the complete `buildDir` is used where it is.
 */
async function swapIn(root: string, buildDir: string, finalDir: string, key: string): Promise<string> {
  const retired = assertPluginDir(root, path.join(root, `${key}${RETIRED}${randomUUID()}`));
  let moved = false;
  try {
    await fs.rename(finalDir, retired);
    moved = true;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT')
      console.warn('[ladderedSkillPlugin] could not retire the previous build:', error);
  }
  let pluginPath = finalDir;
  try {
    await fs.rename(buildDir, finalDir);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM'].includes(errorCode(error) ?? '')) {
      await removeTree(buildDir).catch(() => {});
      throw error;
    }
    pluginPath = buildDir; // a concurrent build won the name; this build is complete too
  }
  if (moved) await removeTree(retired).catch(() => {});
  return pluginPath;
}

/**
 * Remove a plugin dir built by buildLadderedSkillPlugin (read-only dirs
 * included). Refuses anything that is not a direct child of `root`.
 */
export async function removeLadderedSkillPlugin(dir: string, root: string = ladderedSkillPluginRoot()): Promise<void> {
  const resolved = assertPluginDir(root, dir);
  liveDirs.delete(resolved);
  await removeTree(resolved);
}

/**
 * Delete plugin dirs no live session of this process uses: half-built and
 * retired dirs older than LADDERED_PLUGIN_HALF_BUILT_MS, and any other dir
 * untouched for LADDERED_PLUGIN_STALE_MS (left behind by a crash or restart).
 * Returns the names removed.
 */
export async function sweepLadderedSkillPlugins(
  root: string = ladderedSkillPluginRoot(),
  now: number = Date.now()
): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(resolvedRoot);
  } catch {
    return removed;
  }
  for (const name of names) {
    const dir = path.join(resolvedRoot, name);
    if (liveDirs.has(dir)) continue;
    const stat = await fs.lstat(dir).catch((): undefined => undefined);
    if (!stat?.isDirectory()) continue;
    const halfBuilt = name.includes(BUILDING) || name.includes(RETIRED);
    if (now - stat.mtimeMs > (halfBuilt ? LADDERED_PLUGIN_HALF_BUILT_MS : LADDERED_PLUGIN_STALE_MS)) {
      try {
        await removeTree(dir);
        removed.push(name);
      } catch (error) {
        console.warn('[ladderedSkillPlugin] sweep could not remove', dir, error);
      }
    }
  }
  return removed;
}

/** The first build under a root sweeps it once per process (no session of ours is live yet). */
function sweepOnce(root: string): Promise<void> {
  let sweep = sweeps.get(root);
  if (!sweep) {
    sweep = sweepLadderedSkillPlugins(root).then(
      (): undefined => undefined,
      (): undefined => undefined
    );
    sweeps.set(root, sweep);
  }
  return sweep;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Remove a tree, making read-only dirs writable first. Missing is fine. */
async function removeTree(dir: string): Promise<void> {
  await makeWritable(dir);
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Where one bounded-set skill is copied from, or `undefined` when there is no
 * acceptable source. See the module comment for the order.
 */
export async function resolveLadderedSkillSource(
  skill: BoundedSkillSource,
  roots: LadderedSkillRoots,
  blocked: ReadonlySet<string> = new Set()
): Promise<{ dir: string; kind: LadderedSkillSourceKind } | undefined> {
  if (skill.label !== 'skill') {
    if (!(await isDirectory(skill.sourceDir))) return undefined;
    return { dir: skill.sourceDir, kind: skill.label === 'builtin skill' ? 'builtin' : 'extra' };
  }

  const colon = skill.name.indexOf(':');
  if (colon < 0) {
    if (await isDirectory(skill.sourceDir)) {
      const bundled = isInside(path.resolve(getBuiltinSkillsCopyDir()), path.resolve(skill.sourceDir));
      return { dir: skill.sourceDir, kind: bundled ? 'bundled' : 'library' };
    }
    return userSkillDir(roots, skill.name);
  }

  const namespace = skill.name.slice(0, colon);
  const name = skill.name.slice(colon + 1);
  if (blocked.has(name)) return undefined;
  if (isSegment(namespace)) {
    const pluginRoot = path.join(roots.skillSourcesDir, namespace, 'skills');
    const dir = await containedSkillDir(pluginRoot, name, [pluginRoot]);
    if (dir) return { dir, kind: 'plugin-copy' };
  }
  const found = await userSkillDir(roots, name);
  if (found) console.warn(`[ladderedSkillPlugin] ${skill.name} has no ${namespace} copy; using ${found.dir}`);
  return found;
}

/** The first `<root>/<name>` across the user skill roots, contained in any of them. */
async function userSkillDir(
  roots: LadderedSkillRoots,
  name: string
): Promise<{ dir: string; kind: LadderedSkillSourceKind } | undefined> {
  const allowed = roots.userSkillRoots.map((root) => root.dir);
  for (const root of roots.userSkillRoots) {
    const dir = await containedSkillDir(root.dir, name, allowed);
    if (dir) return { dir, kind: root.kind };
  }
  return undefined;
}

/** `<root>/<name>` when it is a directory whose realpath is inside realpath() of an allowed root. */
async function containedSkillDir(root: string, name: string, allowed: readonly string[]): Promise<string | undefined> {
  if (!isSegment(name)) return undefined;
  try {
    const real = await fs.realpath(path.join(root, name));
    const realRoots = await Promise.all(allowed.map((dir) => fs.realpath(dir).catch((): undefined => undefined)));
    if (!realRoots.some((realRoot) => realRoot && isInside(realRoot, real))) return undefined;
    return (await isDirectory(real)) ? real : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate.startsWith(root + path.sep);
}

function isSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/:]/.test(name);
}

/** The directory a skill gets under skills/ (`:` is not portable in a file name). */
function pluginSkillDirName(name: string): string | undefined {
  const dirName = name.replace(/:/g, '__');
  return dirName && dirName !== '.' && dirName !== '..' && !/[\\/]/.test(dirName) ? dirName : undefined;
}

async function isDirectory(dir: string): Promise<boolean> {
  return (await fs.stat(dir).catch((): undefined => undefined))?.isDirectory() ?? false;
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
 * is copied as its content when it resolves inside `realRoot`; any other
 * symlink is skipped), and every SKILL.md reduced to descriptive frontmatter.
 * The top-level SKILL.md is renamed to `skillName`.
 */
async function copySkillTree(src: string, dest: string, realRoot: string, skillName?: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (isPluginLikeEntry(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const real = await fs.realpath(from).catch((): undefined => undefined);
      const target = real && isInside(realRoot, real) ? await fs.stat(real) : undefined;
      isDir = false;
      isFile = target?.isFile() ?? false;
    }
    if (isDir) {
      await copySkillTree(from, to, realRoot);
    } else if (isFile) {
      if (entry.name.toLowerCase() === 'skill.md') {
        const override = skillName && entry.name === 'SKILL.md' ? skillName : undefined;
        await fs.writeFile(to, sanitizeSkillMarkdown(await fs.readFile(from, 'utf8'), override));
      } else {
        await fs.copyFile(from, to);
      }
    }
  }
}

/**
 * Entries never copied from a skill, at any depth: dotfiles and dot-dirs
 * (`.mcp.json`, `.claude-plugin`, `.lsp.json`...), anything named `hooks*`,
 * and `agents/` / `commands/` - the shapes of plugin components, kept out even
 * though Claude only reads them at a plugin's root.
 */
export function isPluginLikeEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.') || lower.startsWith('hooks') || lower === 'agents' || lower === 'commands';
}

/**
 * SKILL.md with only SKILL_FRONTMATTER_KEYS left in its frontmatter (and
 * `name` set to `name` when given). Throws when the frontmatter is not a YAML
 * mapping, so the skill is dropped.
 */
export function sanitizeSkillMarkdown(content: string, name?: string): string {
  const match = FRONTMATTER_RE.exec(content);
  const body = match ? content.slice(match[0].length) : content;
  const parsed = match ? yaml.load(match[1]) : undefined;
  if (parsed !== null && parsed !== undefined && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error('SKILL.md frontmatter is not a mapping');
  }
  const kept: Record<string, unknown> = {};
  for (const key of SKILL_FRONTMATTER_KEYS) {
    const value = (parsed as Record<string, unknown> | null | undefined)?.[key];
    if (isPlainValue(value)) kept[key] = value;
  }
  if (name) kept.name = name;
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
