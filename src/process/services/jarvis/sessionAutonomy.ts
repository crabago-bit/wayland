/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The autonomy ladder for a LIVE ACP session: which agents it applies to, and
 * the permission gate that enforces it on native tool calls.
 *
 * WHO IS ON THE LADDER. Only agents with an EXPLICIT entry in
 * `agents.autonomy`. An agent nobody configured keeps exactly the behaviour it
 * had before the ladder existed - no shim, no gate, no mode clamp - so ordinary
 * chats are untouched. (`DEFAULT_AUTONOMY_RUNG` still describes such an agent
 * in the settings UI; it is not enforced on them.) An UNREADABLE rung store
 * falls back to the last copy this process read successfully. With no such
 * copy we cannot tell who is on the ladder, and laddering EVERY agent would
 * break ordinary chats, so the session runs unladdered and an error is logged.
 */

import { autonomyAgentKey, toAutonomyRung } from '@/common/jarvis/autonomy';
import { decideNativePermission, isOptionAboveRung, normalizeServerName } from '@/common/jarvis/nativeAutonomy';
import type { PermissionGate, PermissionGateVerdict } from '@process/acp/session/PermissionResolver';
import type { ToolFilterSpawnAutonomy } from '@process/services/mcpServices/builtinMcpRuntime';
import { ProcessConfig } from '@process/utils/initStorage';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendApprovalTo, type ApprovalRecord } from './approvalsLog';
import { resolveApprovalsLogPath } from './approvalsPath';
import { readHardFloorKeywords } from './hardFloor';

/** Last `agents.autonomy` map read successfully - the fallback for a storage fault. */
let lastGoodRungs: Record<string, unknown> | undefined;

/** Test hook: forget the last-good copy. */
export function resetAutonomyRungCache(): void {
  lastGoodRungs = undefined;
}

/**
 * The ladder snapshot for one agent, or `undefined` when the agent has no
 * configured rung (today's behaviour).
 */
export async function resolveConfiguredSpawnAutonomy(agent: {
  backend: string;
  customAgentId?: string;
}): Promise<ToolFilterSpawnAutonomy | undefined> {
  const key = autonomyAgentKey(agent);
  let stored: Record<string, unknown> | undefined;
  try {
    stored = ((await ProcessConfig.get('agents.autonomy')) as Record<string, unknown> | undefined) ?? {};
    lastGoodRungs = stored;
  } catch (error) {
    stored = lastGoodRungs;
    if (!stored) {
      console.error(`[jarvis] agents.autonomy unreadable and no prior copy; ${key} runs WITHOUT the ladder:`, error);
      return undefined;
    }
    console.error('[jarvis] agents.autonomy unreadable; using the last copy read successfully:', error);
  }
  if (!Object.prototype.hasOwnProperty.call(stored, key)) return undefined;
  return {
    agent: key,
    rung: toAutonomyRung(stored[key]),
    hardFloorKeywords: readHardFloorKeywords(),
    logPath: resolveApprovalsLogPath(),
  };
}

/**
 * Which Claude Code setting sources a LADDERED session may load.
 *
 * Claude Code applies its own `permissions.allow` rules, `defaultMode` and
 * hooks and never asks the ACP client about a call those rules allow - this
 * install's ~/.claude/settings.json allows Edit, Write, Bash(curl *), Slack
 * sends and more, so a rung-1 agent could act without Wayland seeing it.
 * `settingSources` is the bridge's own option (`_meta.claudeCode.options`,
 * spread into the SDK query), so it applies to this session only:
 *
 *  - credentials are NOT settings: the Max subscription login keeps working
 *    from the unchanged CLAUDE_CONFIG_DIR; nothing is copied or linked;
 *  - `user` and `local` are never loaded;
 *  - `project` is loaded only when it is safe: the session's cwd is not $HOME
 *    or an ancestor of it (there `<cwd>/.claude/settings.json` IS the user
 *    file), and neither `<cwd>/.claude/settings.json` nor `settings.local.json`
 *    carries `permissions.allow`, `permissions.defaultMode` or `hooks`.
 *    Otherwise NO source is loaded (`[]`) - which also drops that workspace's
 *    CLAUDE.md and `.claude/skills`;
 *  - the gate refuses writes to `.claude/settings*.json`, so an agent cannot
 *    grant itself rules mid-session.
 */
export async function resolveLadderedSettingSources(
  cwd: string,
  home: string = os.homedir()
): Promise<Array<'project'>> {
  const resolve = async (p: string) => fs.promises.realpath(p).catch(() => path.resolve(p));
  const [where, homeDir] = await Promise.all([resolve(cwd || '.'), resolve(home)]);
  const rel = path.relative(where, homeDir);
  // cwd === $HOME, or $HOME lies below cwd (cwd is an ancestor of $HOME).
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return [];
  // `null` = absent (fine); `undefined` = present but unreadable (not provably safe).
  const files = await Promise.all(
    ['settings.json', 'settings.local.json'].map(async (name) => {
      try {
        return JSON.parse(await fs.promises.readFile(path.join(where, '.claude', name), 'utf8')) as unknown;
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : undefined;
      }
    })
  );
  for (const parsed of files) {
    if (parsed === null) continue;
    if (parsed === undefined) return [];
    const settings = (parsed ?? {}) as { permissions?: { allow?: unknown; defaultMode?: unknown }; hooks?: unknown };
    const allow = settings.permissions?.allow;
    if ((Array.isArray(allow) && allow.length > 0) || settings.permissions?.defaultMode !== undefined) return [];
    if (settings.hooks && typeof settings.hooks === 'object' && Object.keys(settings.hooks).length > 0) return [];
  }
  return ['project'];
}

/**
 * The `_meta` a laddered session of `backend` starts with, if any. `extraOptions`
 * are merged into `claudeCode.options` (e.g. `resume` / `tools` for a fork).
 */
export async function resolveLadderedSessionMeta(
  backend: string,
  cwd: string,
  extraOptions: Record<string, unknown> = {},
  home?: string
): Promise<Record<string, unknown> | undefined> {
  if (backend !== 'claude') return undefined;
  const settingSources = await resolveLadderedSettingSources(cwd, home);
  return { claudeCode: { options: { ...extraOptions, settingSources } } };
}

/**
 * The Claude ACP bridge versions whose `_meta.claudeCode.options` handling was
 * checked against source: the options are spread into the SDK query AFTER the
 * bridge's default `settingSources`, so ours win (claude-agent-acp 0.74.0,
 * `acp-agent.js` createSession). Wayland resolves the latest bridge at launch,
 * so a laddered session confirms the running bridge is inside this range - an
 * unverified bridge might silently ignore the override, and the session then
 * fails closed (laddered agents only).
 */
export const LADDER_VERIFIED_CLAUDE_BRIDGE = {
  name: '@agentclientprotocol/claude-agent-acp',
  minVersion: [0, 74, 0] as const,
  belowMajor: 1,
};

/** Whether a laddered session on `backend` may trust the agent it initialized. */
export function verifyLadderedBridge(
  backend: string,
  initializeResult: unknown
): { ok: true } | { ok: false; reason: string } {
  if (backend !== 'claude') return { ok: true };
  const info = (initializeResult as { agentInfo?: { name?: unknown; version?: unknown } } | null)?.agentInfo;
  const name = typeof info?.name === 'string' ? info.name : '';
  const version = typeof info?.version === 'string' ? info.version : '';
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (name !== LADDER_VERIFIED_CLAUDE_BRIDGE.name || !match) {
    return { ok: false, reason: `unrecognised Claude ACP bridge ${name || '(no agentInfo)'} ${version}`.trim() };
  }
  const v = match.slice(1, 4).map(Number);
  const [minMajor, minMinor, minPatch] = LADDER_VERIFIED_CLAUDE_BRIDGE.minVersion;
  const atLeastMin =
    v[0] > minMajor || (v[0] === minMajor && (v[1] > minMinor || (v[1] === minMinor && v[2] >= minPatch)));
  if (!atLeastMin || v[0] >= LADDER_VERIFIED_CLAUDE_BRIDGE.belowMajor) {
    return { ok: false, reason: `Claude ACP bridge ${version} is outside the range verified for the autonomy ladder` };
  }
  return { ok: true };
}

/**
 * How long a held call waits for a person before it is refused: 15 minutes.
 *
 * Applied to EVERY laddered hold, not only to scheduled runs. A team member,
 * workflow step or channel conversation at rung 2 otherwise waits forever on
 * an approval nobody may be looking at, and stalls its leader with it. In an
 * attended chat a refusal after 15 minutes costs one re-ask.
 */
export const AUTONOMY_HOLD_DEADLINE_MS = 15 * 60_000;

type GateRequest = Parameters<PermissionGate['check']>[0];

/**
 * Build the permission gate for one session. Every refusal, every held call's
 * final answer, and every write that passes at rung >= 3 is written to the
 * approvals ledger - the same file and row shape the shim writes.
 */
export function createAutonomyPermissionGate(
  autonomy: ToolFilterSpawnAutonomy,
  backend: string,
  deps: {
    append?: (logPath: string, record: ApprovalRecord) => void;
    now?: () => number;
    /**
     * Wayland's OWN coordination MCP servers for this session (team / team
     * guide). Their tools move work between Wayland agents and touch nothing
     * outside the app; laddering them would stall every team turn at rung 1-2
     * (and `team_remove_member` would even read as a hard-floor delete).
     */
    internalMcpServers?: readonly string[];
    /**
     * Servers this session published THROUGH the tool-filter shim. The shim is
     * their enforcement point: the gate denies (never holds) their rung-refused
     * writes and leaves their allowed writes for the shim to record.
     */
    shimmedMcpServers?: readonly string[];
    /**
     * False while the agent has not confirmed a mode the rung allows (see
     * AcpAgentV2.enforceLadderedMode). Every write is refused meanwhile.
     */
    isModeConfirmed?: () => boolean;
  } = {}
): PermissionGate {
  const append = deps.append ?? appendApprovalTo;
  const internal = new Set((deps.internalMcpServers ?? []).map(normalizeServerName));
  const shimmedServers = new Set((deps.shimmedMcpServers ?? []).map(normalizeServerName));
  const isInternalTool = (title: string | null | undefined): boolean => {
    const match = /^(?:mcp__)?(.+?)__[A-Za-z0-9_-]+$/.exec((title ?? '').trim());
    return match !== null && internal.has(normalizeServerName(match[1]));
  };
  const now = deps.now ?? Date.now;
  const record = (tool: string, connector: string, decision: ApprovalRecord['decision'], reason: string) =>
    append(autonomy.logPath, {
      ts: now(),
      agent: autonomy.agent,
      rung: autonomy.rung,
      tool,
      connector,
      decision,
      reason,
    });

  return {
    check(request: GateRequest): PermissionGateVerdict {
      if (isInternalTool(request.toolCall.title)) return { action: 'pass' };
      const verdict = decideNativePermission({
        toolCall: request.toolCall,
        rung: autonomy.rung,
        hardFloorKeywords: autonomy.hardFloorKeywords,
        shimmedServers,
      });
      if (verdict.action === 'deny') {
        record(verdict.tool, verdict.connector, 'refused', verdict.reason);
        return { action: 'deny' };
      }
      const isRead = verdict.action === 'pass' && !verdict.loggable;
      if (!isRead && deps.isModeConfirmed && !deps.isModeConfirmed()) {
        record(
          verdict.tool,
          verdict.connector,
          'refused',
          `Session mode not confirmed within autonomy rung ${autonomy.rung}; writes are refused until it is.`
        );
        return { action: 'deny' };
      }
      // A mode-switch request may carry options that would lift the session
      // above its rung (e.g. "auto-accept edits", bypass). Those are withheld.
      const options =
        request.toolCall.kind === 'switch_mode'
          ? request.options.filter((option) => !isOptionAboveRung(option.optionId, autonomy.rung, backend))
          : undefined;
      if (options && !options.some((option) => option.kind.startsWith('allow'))) {
        const reason = `Mode change above autonomy rung ${autonomy.rung} withheld.`;
        record(verdict.tool, verdict.connector, 'refused', reason);
        return { action: 'deny' };
      }
      if (verdict.action === 'hold') {
        // A held call is approved ONCE. An `allow_always` answer would make the
        // backend (e.g. the Claude ACP bridge) remember a session rule and stop
        // asking, so every later matching call would bypass the ladder.
        const once = (options ?? request.options).filter((option) => option.kind !== 'allow_always');
        if (!once.some((option) => option.kind.startsWith('allow'))) {
          record(verdict.tool, verdict.connector, 'refused', `${verdict.reason} No one-time approval was offered.`);
          return { action: 'deny' };
        }
        return {
          action: 'hold',
          options: once,
          deadlineMs: AUTONOMY_HOLD_DEADLINE_MS,
          settle: (approved: boolean) =>
            record(
              verdict.tool,
              verdict.connector,
              approved ? 'allowed' : 'refused',
              approved ? `Approved by a person at autonomy rung ${autonomy.rung}.` : verdict.reason
            ),
        };
      }
      if (verdict.loggable) record(verdict.tool, verdict.connector, 'allowed', verdict.reason);
      return { action: 'pass', options };
    },
  };
}
