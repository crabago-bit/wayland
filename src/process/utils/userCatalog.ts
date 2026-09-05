/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * userCatalog - drop-in "assistant packs".
 *
 * A pack is a single `*.pack.json` file dropped into
 * `<userData>/config/assistant-packs/` (see `getAssistantPacksDir()`); its
 * assistants and team launchers show up in Wayland on the next boot with zero
 * UI clicks. This is the USER-authored twin of `builtinCatalog.ts`: both build
 * `AcpBackendConfig` rows and both are merged into `config.assistants` by
 * `initStorage`, so a pack assistant reaches /assistants, the roster and (for
 * `kind:'team'` rows) /teams through exactly the same code path as a built-in.
 *
 * THE ONE DIFFERENCE THAT MATTERS is ownership. Catalog rows are
 * `isBuiltin:true` - the app owns them and rewrites them on every boot. Pack
 * rows are `isBuiltin:false`: the user may rename, re-prompt, re-skill or
 * delete them, and the pack must not undo that. So application is gated on a
 * VERSION, recorded per pack under the `assistantPacks.applied` config key:
 *
 *   - pack never applied            -> insert every row that is not already there
 *   - pack version <= applied       -> do NOTHING (an edit survives; a delete
 *                                      is not resurrected)
 *   - pack version >  applied       -> insert new ids AND refresh existing pack
 *                                      rows (the author shipped a new revision;
 *                                      user `enabled` is still preserved)
 *
 * Because a same-version re-run is a total no-op, a pack that GAINS an
 * assistant must also bump `version` for it to appear. That is the price of
 * "deleting one must stick", and it is documented in
 * docs/guides/assistant-packs.md.
 *
 * CONTEXT LIVES ON DISK, NOT IN CONFIG. The record's prompt body is written to
 * `<assistantsDir>/<assistantId>.en-US.md`, which is the file the existing
 * `fsBridge.readAssistantResource` user-data lookup already reads first and the
 * one the rules editor writes back to. Storing it in `config.assistants`
 * instead would fork the prompt the moment a user edited it in the UI.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AcpBackendConfig } from '@/common/types/acpTypes';
import { resolvePresetAgentType } from '@/common/config/presets/assistantDefaults';
import { autonomyAgentKey, type AutonomyRung } from '@/common/jarvis/autonomy';

/** Id prefix tagging every pack-owned row (never collides with builtin-/custom-/ext-/hermes-profile-). */
export const ASSISTANT_PACK_ID_PREFIX = 'pack-';

/** Only files ending in this are read out of the packs dir. */
export const ASSISTANT_PACK_FILE_SUFFIX = '.pack.json';

/** Locale every pack prompt is authored in; other locales fall back to it at read time. */
const PACK_PROMPT_LOCALE = 'en-US';

/**
 * A pack name and a record id both become part of an assistant id and (for the
 * name) a config key, so restrict them to a conservative slug charset. Anything
 * else is rejected rather than sanitized - a silently rewritten id would not
 * match the ids the pack's own teams reference.
 */
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A promptFile is joined onto the packs dir, so it must be a plain file name. */
const SAFE_PROMPT_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type AssistantPackAssistant = {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  presetAgentType?: string;
  promptFile?: string;
  prompts?: string[];
  enabledSkills?: string[];
  tier?: string;
  autonomyRung?: number;
  workspace?: string;
};

export type AssistantPackTask = {
  subject: string;
  description?: string;
  owner?: string;
  blockedBy?: string[];
};

export type AssistantPackTeam = {
  id: string;
  name: string;
  description?: string;
  workspace?: string;
  workspaceMode?: 'shared' | 'isolated';
  leader?: string;
  members?: string[];
  tasks?: AssistantPackTask[];
};

export type AssistantPack = {
  pack: string;
  version: number;
  generatedAt?: string;
  assistants: AssistantPackAssistant[];
  teams: AssistantPackTeam[];
};

/** Parse outcome: either a usable pack or the reason it was rejected. */
export type AssistantPackParseResult = { pack: AssistantPack } | { error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

const strArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return items.length > 0 ? items : undefined;
};

/**
 * Strip whatever pack scoping a record id already carries, leaving the bare
 * slug. Generators name records three ways in practice - `scout`,
 * `warrior-scout`, `pack-warrior-scout` - and all three must land on ONE id, or
 * a team's `members` list stops matching the assistants it names.
 */
export function packBareId(packName: string, recordId: string): string {
  const full = `${ASSISTANT_PACK_ID_PREFIX}${packName}-`;
  if (recordId.startsWith(full)) return recordId.slice(full.length);
  if (recordId.startsWith(`${packName}-`)) return recordId.slice(packName.length + 1);
  return recordId;
}

/** The assistant id a pack record lands on: `pack-<pack>-<bare slug>`. */
export function packAssistantId(packName: string, recordId: string): string {
  return `${ASSISTANT_PACK_ID_PREFIX}${packName}-${packBareId(packName, recordId)}`;
}

/** True when the id belongs to some assistant pack. */
export function isPackAssistantId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(ASSISTANT_PACK_ID_PREFIX);
}

/**
 * Validate and normalize one pack file's text. Never throws: malformed JSON, a
 * bad pack name or a non-positive version reject the WHOLE file (an unusable
 * header makes every row below it unattributable), while an individual bad
 * assistant/team row is dropped and the rest of the pack still applies.
 * Duplicate ids keep the first occurrence.
 */
export function parseAssistantPack(text: string): AssistantPackParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return { error: `invalid JSON (${(error as Error).message})` };
  }
  if (!isRecord(raw)) return { error: 'top level must be an object' };

  const packName = str(raw.pack);
  if (!packName || !SAFE_SLUG.test(packName)) return { error: 'missing or invalid "pack" name' };

  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { error: 'missing or invalid "version" (expected a positive integer)' };
  }

  const seen = new Set<string>();
  const assistants: AssistantPackAssistant[] = [];
  for (const entry of Array.isArray(raw.assistants) ? raw.assistants : []) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id);
    const name = str(entry.name);
    if (!id || !name) continue;
    const bare = packBareId(packName, id);
    if (!SAFE_SLUG.test(bare)) continue;
    const resolved = packAssistantId(packName, id);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const promptFile = str(entry.promptFile);
    const rung = typeof entry.autonomyRung === 'number' ? Math.trunc(entry.autonomyRung) : undefined;
    assistants.push({
      id: resolved,
      name,
      description: str(entry.description),
      avatar: str(entry.avatar),
      presetAgentType: str(entry.presetAgentType),
      promptFile: promptFile && SAFE_PROMPT_FILE.test(promptFile) ? promptFile : undefined,
      prompts: strArray(entry.prompts),
      enabledSkills: strArray(entry.enabledSkills),
      tier: str(entry.tier),
      autonomyRung: rung !== undefined && rung >= 1 && rung <= 4 ? rung : undefined,
      workspace: str(entry.workspace),
    });
  }

  const teams: AssistantPackTeam[] = [];
  for (const entry of Array.isArray(raw.teams) ? raw.teams : []) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id);
    const name = str(entry.name);
    if (!id || !name) continue;
    const bare = packBareId(packName, id);
    if (!SAFE_SLUG.test(bare)) continue;
    const resolved = packAssistantId(packName, id);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const tasks: AssistantPackTask[] = [];
    for (const task of Array.isArray(entry.tasks) ? entry.tasks : []) {
      if (!isRecord(task)) continue;
      const subject = str(task.subject);
      if (!subject) continue;
      tasks.push({
        subject,
        description: str(task.description),
        owner: str(task.owner) ? packAssistantId(packName, str(task.owner) as string) : undefined,
        blockedBy: strArray(task.blockedBy),
      });
    }

    const mode = str(entry.workspaceMode);
    teams.push({
      id: resolved,
      name,
      description: str(entry.description),
      workspace: str(entry.workspace),
      workspaceMode: mode === 'shared' || mode === 'isolated' ? mode : undefined,
      leader: str(entry.leader) ? packAssistantId(packName, str(entry.leader) as string) : undefined,
      members: strArray(entry.members)?.map((m) => packAssistantId(packName, m)),
      tasks,
    });
  }

  return {
    pack: { pack: packName, version, generatedAt: str(raw.generatedAt), assistants, teams },
  };
}

/** Build the `AcpBackendConfig` row for one pack assistant. */
export function buildPackAssistant(pack: AssistantPack, record: AssistantPackAssistant): AcpBackendConfig {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    avatar: record.avatar,
    presetAgentType: resolvePresetAgentType(record.presetAgentType),
    category: pack.pack,
    kind: 'specialist',
    enabled: true,
    isPreset: true,
    // Editable and deletable: this row belongs to the user, not to the app.
    isBuiltin: false,
    enabledSkills: record.enabledSkills,
    prompts: record.prompts,
    packMeta:
      record.tier || record.workspace ? { tier: record.tier, workspace: record.workspace, pack: pack.pack } : undefined,
  };
}

/**
 * Render a team's task list as the kickoff prefill body. Catalog records have
 * no way to write rows into the `team_tasks` table (that table is keyed by a
 * live `teams` row, which only exists after the user launches the launcher), so
 * the pipeline is expressed the way every built-in team launcher expresses it:
 * an ordered instruction the leader reads on the first turn.
 */
export function renderTeamTaskPrefill(team: AssistantPackTeam): string {
  const lines: string[] = [];
  lines.push(`Assemble the ${team.name} team and run the following pipeline in order.`);
  if (team.leader) lines.push(`Leader: ${team.leader}.`);
  if (team.members && team.members.length > 0) lines.push(`Teammates: ${team.members.join(', ')}.`);
  if (team.workspace) lines.push(`Workspace: ${team.workspace} (${team.workspaceMode ?? 'shared'}).`);
  lines.push('');
  team.tasks?.forEach((task, index) => {
    const owner = task.owner ? ` [owner: ${task.owner}]` : '';
    const blocked = task.blockedBy && task.blockedBy.length > 0 ? ` [blocked by: ${task.blockedBy.join('; ')}]` : '';
    lines.push(`${index + 1}. ${task.subject}${owner}${blocked}`);
    if (task.description) lines.push(`   ${task.description}`);
  });
  lines.push('');
  lines.push('Do not start a task until every task it is blocked by has been reported complete.');
  return lines.join('\n');
}

/** Build the `kind:'team'` launcher row for one pack team. */
export function buildPackTeam(pack: AssistantPack, team: AssistantPackTeam): AcpBackendConfig {
  // Leader first: the roster order is what the launcher spawns in.
  const members = team.members ?? [];
  const teammates = team.leader ? [team.leader, ...members.filter((m) => m !== team.leader)] : members;
  return {
    id: team.id,
    name: team.name,
    description: team.description ?? `Team launcher - ${teammates.length} teammates from the ${pack.pack} pack.`,
    presetAgentType: resolvePresetAgentType(undefined),
    category: pack.pack,
    kind: 'team',
    enabled: true,
    isPreset: true,
    isBuiltin: false,
    teammates,
    kickoffs: [
      {
        id: `${team.id}-pipeline`,
        text: `Run the ${team.name} pipeline (${team.tasks?.length ?? 0} tasks).`,
        prefill: renderTeamTaskPrefill(team),
        scenario: 'cold-start',
      },
    ],
    packMeta: team.workspace ? { workspace: team.workspace, pack: pack.pack } : { pack: pack.pack },
  };
}

export type PackReconcileResult = {
  next: AcpBackendConfig[];
  changed: boolean;
  /** Ids inserted by this run. */
  added: string[];
  /** Rows the run left exactly as they were (already present, or the whole pack was skipped). */
  unchanged: number;
  /** True when the pack was already applied at this version or newer and nothing was touched. */
  skipped: boolean;
};

/**
 * Merge one pack's rows into the current `assistants` list under the version
 * rules described at the top of this file. Only ever touches ids belonging to
 * this pack; every other row is passed through untouched.
 */
export function reconcilePackAssistants(
  existing: AcpBackendConfig[],
  records: AcpBackendConfig[],
  options: { packVersion: number; appliedVersion?: number }
): PackReconcileResult {
  const { packVersion, appliedVersion } = options;
  if (appliedVersion !== undefined && packVersion <= appliedVersion) {
    return { next: existing, changed: false, added: [], unchanged: records.length, skipped: true };
  }

  const next = [...existing];
  const added: string[] = [];
  let changed = false;

  for (const record of records) {
    const index = next.findIndex((a) => a.id === record.id);
    if (index < 0) {
      next.push(record);
      added.push(record.id);
      changed = true;
      continue;
    }
    // The row is already there. On a first application leave it strictly alone;
    // only an explicit version bump licenses overwriting the user's copy, and
    // even then `enabled` stays the user's.
    if (appliedVersion === undefined) continue;
    const current = next[index];
    const merged: AcpBackendConfig = { ...current, ...record, enabled: current.enabled ?? record.enabled };
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      next[index] = merged;
      changed = true;
    }
  }

  return { next, changed, added, unchanged: records.length - added.length, skipped: false };
}

/**
 * Fill the autonomy rung for pack assistants that have none stored. An agent the
 * user already placed on a rung is never moved - the pack declares a starting
 * point, not a policy override.
 */
export function applyPackAutonomy(
  current: Record<string, AutonomyRung>,
  records: AssistantPackAssistant[]
): { next: Record<string, AutonomyRung>; changed: boolean } {
  const next = { ...current };
  let changed = false;
  for (const record of records) {
    if (record.autonomyRung === undefined) continue;
    const key = autonomyAgentKey({ backend: 'custom', customAgentId: record.id });
    if (next[key] !== undefined) continue;
    next[key] = record.autonomyRung as AutonomyRung;
    changed = true;
  }
  return { next, changed };
}

/** One line per pack, exactly as it is logged at boot. */
export function formatPackSummary(summary: {
  pack: string;
  version: number;
  assistants: number;
  teams: number;
  added: number;
  unchanged: number;
}): string {
  const teams = `${summary.teams} team${summary.teams === 1 ? '' : 's'}`;
  return (
    `[assistantPacks] ${summary.pack} v${summary.version}: ${summary.assistants} assistants, ${teams} ` +
    `(${summary.added} new, ${summary.unchanged} unchanged)`
  );
}

/** IO seam - injected with the real dirs + ConfigStorage at the call site, stubbed in tests. */
export type AssistantPackIo = {
  /** Directory holding `*.pack.json` files; created when missing. */
  packsDir: string;
  /** Directory the per-assistant `<id>.en-US.md` prompt bodies are written to. */
  assistantsDir: string;
  getAssistants: () => Promise<AcpBackendConfig[]>;
  setAssistants: (next: AcpBackendConfig[]) => Promise<void>;
  getApplied: () => Promise<Record<string, number> | undefined>;
  setApplied: (next: Record<string, number>) => Promise<void>;
  getAutonomy: () => Promise<Record<string, AutonomyRung> | undefined>;
  setAutonomy: (next: Record<string, AutonomyRung>) => Promise<void>;
  /** Defaults to console.log; injected in tests to assert the boot line. */
  log?: (line: string) => void;
  warn?: (line: string) => void;
};

export type AssistantPackSummary = {
  pack: string;
  version: number;
  assistants: number;
  teams: number;
  added: number;
  unchanged: number;
  skipped: boolean;
};

/**
 * Read every pack in `packsDir` and merge it into the assistants store. Creates
 * the directory when absent (so the drop-in path exists for the user to find),
 * never throws on a bad pack, and logs one line per pack.
 */
export async function applyAssistantPacks(io: AssistantPackIo): Promise<AssistantPackSummary[]> {
  const log = io.log ?? ((line: string) => console.log(line));
  const warn = io.warn ?? ((line: string) => console.warn(line));

  await mkdir(io.packsDir, { recursive: true }).catch((): undefined => undefined);

  let files: string[];
  try {
    files = (await readdir(io.packsDir)).filter((f) => f.endsWith(ASSISTANT_PACK_FILE_SUFFIX)).toSorted();
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const applied = (await io.getApplied()) ?? {};
  let assistants = await io.getAssistants();
  let autonomy = (await io.getAutonomy()) ?? {};
  let assistantsChanged = false;
  let autonomyChanged = false;
  let appliedChanged = false;
  const summaries: AssistantPackSummary[] = [];

  for (const file of files) {
    const fullPath = path.join(io.packsDir, file);
    let text: string;
    try {
      text = await readFile(fullPath, 'utf-8');
    } catch (error) {
      warn(`[assistantPacks] ${file}: unreadable (${(error as Error).message})`);
      continue;
    }

    const parsed = parseAssistantPack(text);
    if ('error' in parsed) {
      warn(`[assistantPacks] ${file}: ${parsed.error}`);
      continue;
    }
    const pack = parsed.pack;

    // Resolve prompt bodies before building rows: an assistant that DECLARES a
    // promptFile which cannot be read is a broken entry, not a promptless one.
    const usable: AssistantPackAssistant[] = [];
    const prompts = new Map<string, string>();
    for (const record of pack.assistants) {
      if (!record.promptFile) {
        usable.push(record);
        continue;
      }
      try {
        prompts.set(record.id, await readFile(path.join(io.packsDir, record.promptFile), 'utf-8'));
        usable.push(record);
      } catch {
        warn(`[assistantPacks] ${pack.pack}: ${record.id} skipped - promptFile "${record.promptFile}" not readable`);
      }
    }

    const rows = [
      ...usable.map((record) => buildPackAssistant(pack, record)),
      ...pack.teams.map((team) => buildPackTeam(pack, team)),
    ];
    const result = reconcilePackAssistants(assistants, rows, {
      packVersion: pack.version,
      appliedVersion: applied[pack.pack],
    });
    assistants = result.next;
    assistantsChanged ||= result.changed;

    if (!result.skipped) {
      // Write prompt bodies for the rows this run actually inserted or
      // refreshed. Skipped packs write nothing, so a user's edited prompt file
      // survives every same-version boot.
      const targets = new Set(applied[pack.pack] === undefined ? result.added : rows.map((r) => r.id));
      const writes = [...prompts].filter(([id]) => targets.has(id));
      if (writes.length > 0) {
        await mkdir(io.assistantsDir, { recursive: true }).catch((): undefined => undefined);
        await Promise.all(
          writes.map(([id, body]) =>
            writeFile(path.join(io.assistantsDir, `${id}.${PACK_PROMPT_LOCALE}.md`), body, 'utf-8').catch(
              (error: Error) => {
                warn(`[assistantPacks] ${pack.pack}: failed to write prompt for ${id} (${error.message})`);
              }
            )
          )
        );
      }

      const rungs = applyPackAutonomy(autonomy, usable);
      autonomy = rungs.next;
      autonomyChanged ||= rungs.changed;

      applied[pack.pack] = pack.version;
      appliedChanged = true;
    }

    const summary: AssistantPackSummary = {
      pack: pack.pack,
      version: pack.version,
      assistants: usable.length,
      teams: pack.teams.length,
      added: result.added.length,
      unchanged: rows.length - result.added.length,
      skipped: result.skipped,
    };
    summaries.push(summary);
    log(formatPackSummary(summary));
  }

  if (assistantsChanged) await io.setAssistants(assistants);
  if (autonomyChanged) await io.setAutonomy(autonomy);
  if (appliedChanged) await io.setApplied(applied);

  return summaries;
}
