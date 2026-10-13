/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The autonomy ladder for NATIVE tool calls - the shell, file edits, moves and
 * deletes an ACP agent performs itself rather than through an MCP connector.
 *
 * The tool-filter shim only ever sees `tools/call` on connectors it is
 * interposed on. Everything else an agent does arrives at Wayland, if at all,
 * as an ACP `session/request_permission`, so that is where the same ladder has
 * to be applied. Same verdict ORDER as {@link decideToolCall}: the hard floor
 * first (no rung buys past it), then the rung.
 *
 * Pure and dependency-light (only `@/common`), so the session layer, the tests
 * and the settings copy can all reach the identical verdict.
 *
 * WHAT A RUNG MEANS HERE (autonomy.md):
 *   1 SUGGEST          - a write action is DENIED; the agent says what it would do.
 *   2 DRAFT -> APPROVE - a write action is HELD for an explicit human answer. It
 *                        is never auto-approved by a session mode, a trusted
 *                        workspace, a cached "allow always" or the Autopilot
 *                        guardrail, and an unattended hold expires as a denial.
 *   3 ACT -> REPORT    - a write action passes to the normal permission flow and
 *                        is recorded.
 *   4 AUTONOMOUS       - same as 3: passes and is recorded ("logged, not asked").
 *
 * Read-shaped kinds (read, search, think, fetch) pass at every rung unrecorded:
 * the rungs withhold EFFECT, not information - the same line the shim draws.
 */

import { classifyCommand, extractCommandText } from '@/common/security/destructiveCommand';
import { isCodexAutoApproveMode } from '@/common/types/codex/codexModes';
import { getFullAutoMode } from '@/common/types/agentModes';
import { decideToolCall, isHardFloorTool, type AutonomyRung } from './autonomy';
import { classifyShellCommand, shellWritesAgentSettings } from './shellFloor';

/** The slice of an ACP permission request this policy reads. */
export type NativeToolCall = {
  kind?: string | null;
  title?: string | null;
  rawInput?: unknown;
};

export type NativePermissionVerdict = {
  /**
   * `pass`  - hand the request to the normal permission flow.
   * `deny`  - answer it with a rejection now; no human is asked.
   * `hold`  - a human must answer it; nothing may auto-approve it.
   */
  action: 'pass' | 'deny' | 'hold';
  reason: string;
  /** Whether this verdict belongs in approvals.jsonl. */
  loggable: boolean;
  /** Ledger `tool` column. */
  tool: string;
  /** Ledger `connector` column: the MCP server, or `native`. */
  connector: string;
};

/** ACP kinds that only read or reason. Everything else is treated as a write. */
const READ_KINDS: ReadonlySet<string> = new Set(['read', 'search', 'think', 'fetch']);

/**
 * A fully-qualified MCP tool name as ACP backends put it in `toolCall.title`
 * (`mcp__server__tool` or `server__tool`). Same shape the Autopilot guardrail
 * recognises in `destructiveCommand.ts`.
 */
const MCP_TOOL_TITLE = /^(?:mcp__)?([a-z0-9_.-]+?)__([a-z0-9_.-]+)$/i;

/** Claude Code's project/local settings files - where permission rules live. */
const AGENT_SETTINGS_PATH = /(?:^|[\s\\/"'=>])\.claude[\\/]settings(?:\.local)?\.json\b/i;

/** True when a write targets the backend's own permission settings. */
function touchesAgentSettings(toolCall: NativeToolCall, title: string): boolean {
  if (toolCall.kind === 'execute') return shellWritesAgentSettings(shellCommandOf(toolCall, title));
  const input = toolCall.rawInput as { file_path?: unknown; path?: unknown; notebook_path?: unknown } | undefined;
  const locations = (toolCall as { locations?: Array<{ path?: unknown }> }).locations ?? [];
  const candidates = [input?.file_path, input?.path, input?.notebook_path, ...locations.map((l) => l.path)];
  if (candidates.some((value) => typeof value === 'string' && AGENT_SETTINGS_PATH.test(value))) return true;
  // A write with no structured path: fall back to the title.
  return candidates.every((value) => typeof value !== 'string') && AGENT_SETTINGS_PATH.test(title);
}

/** The shell command an execute call will run: `rawInput.command`/`cmd`, else its title. */
function shellCommandOf(toolCall: NativeToolCall, title: string): string {
  const input = toolCall.rawInput as { command?: unknown; cmd?: unknown } | undefined;
  for (const candidate of [input?.command, input?.cmd]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (Array.isArray(candidate)) {
      const words = candidate.filter((word): word is string => typeof word === 'string');
      if (words.length > 0) return words.join(' ');
    }
  }
  return title;
}

/** Modes that auto-approve EVERYTHING on the agent side, so no request reaches us. */
const BLANKET_BYPASS_MODES: ReadonlySet<string> = new Set(['yolo', 'bypassPermissions', 'auto']);

/** Modes that auto-approve SOME writes (edits) without a human. */
const PARTIAL_AUTO_MODES: ReadonlySet<string> = new Set(['acceptEdits', 'autoEdit', 'auto_edit', 'autoGuarded']);

/**
 * Server names as they appear inside an MCP tool title. Backends normalise the
 * name they were given (Claude Code maps anything outside [A-Za-z0-9_-] to
 * `_`), so both sides are compared in that form.
 */
export function normalizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase();
}

function truncate(value: string, max = 160): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** True when `mode` makes the agent act without asking Wayland at all. */
export function isBlanketBypassMode(mode: string | undefined | null): boolean {
  if (!mode) return false;
  return BLANKET_BYPASS_MODES.has(mode) || isCodexAutoApproveMode(mode);
}

/**
 * The session mode an agent on `rung` may actually run in.
 *
 * - Rung 1-2: no mode that approves anything without a human - blanket bypass
 *   AND partial auto (accept-edits, guarded-auto) both clamp to `default`. A
 *   draft-and-ask agent whose edits are auto-accepted is not drafting.
 * - Rung 3-4: a BLANKET bypass is clamped too, because in that mode the agent
 *   never asks and the hard floor on native tools could not be applied. It
 *   becomes the backend's guarded full-auto (claude: `autoGuarded`, which still
 *   runs unattended but routes every escalated call through the floor) or
 *   `default` where the backend's full-auto is itself a blanket bypass.
 *
 * An ABSENT mode becomes `default`: left unset, the Claude backend falls back
 * to the operator's `~/.claude/settings.json` `defaultMode`, which may be a
 * bypass mode the ladder never sees.
 */
export function clampSessionModeForRung(mode: string | undefined | null, rung: AutonomyRung, backend: string): string {
  if (!mode) return 'default';
  if (rung <= 2) {
    return isBlanketBypassMode(mode) || PARTIAL_AUTO_MODES.has(mode) ? 'default' : mode;
  }
  if (!isBlanketBypassMode(mode)) return mode;
  const guarded = getFullAutoMode(backend);
  return isBlanketBypassMode(guarded) ? 'default' : guarded;
}

/**
 * The single native-tool verdict. Order is load-bearing: hard floor, then rung.
 */
export function decideNativePermission(input: {
  toolCall: NativeToolCall;
  rung: AutonomyRung;
  hardFloorKeywords?: readonly string[];
  /**
   * MCP servers this session published THROUGH the tool-filter shim, by
   * {@link normalizeServerName}. Their calls meet the shim's verdict as well.
   */
  shimmedServers?: ReadonlySet<string>;
}): NativePermissionVerdict {
  const { toolCall, rung } = input;
  const keywords = input.hardFloorKeywords ?? [];
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : '';
  const title = typeof toolCall.title === 'string' ? toolCall.title.trim() : '';

  // An MCP tool call. Decided on the TOOL half only (`server__tool` -> `tool`),
  // exactly as the shim decides it - a floor word in a server's NAME must not
  // floor every tool on that server.
  const mcp = MCP_TOOL_TITLE.exec(title);
  if (mcp) {
    const [, server, toolName] = mcp;
    const verdict = decideToolCall({ toolName, rung, hardFloorKeywords: keywords });
    const base = { tool: truncate(`${server}__${toolName}`), connector: server };
    const shimmed = input.shimmedServers?.has(normalizeServerName(server)) === true;
    if (verdict.decision === 'allowed') {
      // A shimmed server's allowed write is recorded by the shim when it runs;
      // recording it here too would put two lines in the ledger for one call.
      return { action: 'pass', reason: verdict.reason, loggable: verdict.loggable && !shimmed, ...base };
    }
    // Refused by the ladder. Rung 2 asks a person - but ONLY for a server the
    // backend loaded itself. A server Wayland published through the shim would
    // refuse the call anyway (the shim cannot ask), so holding it would only
    // collect an approval that cannot take effect. Hard floor is never held.
    const floor = isHardFloorTool(toolName, keywords);
    return {
      action: !floor && !shimmed && rung === 2 ? 'hold' : 'deny',
      reason: verdict.reason,
      loggable: true,
      ...base,
    };
  }

  const tool = truncate(`${kind || 'unknown'}: ${title}`);
  const native = { tool, connector: 'native' };

  if (READ_KINDS.has(kind)) {
    return { action: 'pass', reason: 'Read-only tool.', loggable: false, ...native };
  }

  // ── Hard floor ─────────────────────────────────────────────────
  // Writing the backend's own permission settings would let an agent grant
  // itself rules that approve future calls without asking - widening its own
  // authority. Never, at any rung.
  if (touchesAgentSettings(toolCall, title)) {
    return {
      action: 'deny',
      reason: 'Hard floor: an agent may not edit its own permission settings (.claude/settings*.json).',
      loggable: true,
      ...native,
    };
  }
  if (kind === 'delete') {
    return {
      action: 'deny',
      reason: 'Hard floor: deleting data is never done by an agent, at any autonomy rung.',
      loggable: true,
      ...native,
    };
  }
  if (kind === 'execute') {
    const command = extractCommandText(toolCall as { kind?: string; title?: string; rawInput?: unknown });
    const catastrophic = classifyCommand(command);
    // The floor/delete checks read the COMMAND itself, never the agent's prose
    // `description` ("Delete the old drafts") that rides along in rawInput.
    const shell = shellCommandOf(toolCall, title);
    const verdict = classifyShellCommand(shell, keywords);
    if (catastrophic.destructive || verdict.floor) {
      const why = catastrophic.reason || (verdict.floor ? verdict.reason : 'hard-floor action');
      return {
        action: 'deny',
        reason: `Hard floor: ${why}; never run by an agent, at any autonomy rung.`,
        loggable: true,
        ...native,
      };
    }
  }

  // ── Rung ───────────────────────────────────────────────────────
  if (kind === 'switch_mode') {
    // A change to the permission regime itself. Never self-granted below rung 3.
    return rung <= 2
      ? { action: 'hold', reason: `Mode change requires approval (autonomy rung ${rung}).`, loggable: true, ...native }
      : { action: 'pass', reason: `Mode change allowed at autonomy rung ${rung}.`, loggable: true, ...native };
  }
  if (rung === 1) {
    return {
      action: 'deny',
      reason: 'Autonomy rung 1 (SUGGEST): write actions are refused. Recommend it instead.',
      loggable: true,
      ...native,
    };
  }
  if (rung === 2) {
    return {
      action: 'hold',
      reason: 'Autonomy rung 2 (DRAFT -> APPROVE): requires explicit approval.',
      loggable: true,
      ...native,
    };
  }
  return { action: 'pass', reason: `Write action allowed at autonomy rung ${rung}.`, loggable: true, ...native };
}

/**
 * Whether a `switch_mode` permission OPTION would move the session into a mode
 * the rung does not allow (e.g. ExitPlanMode's "auto-accept edits" or a bypass
 * option). The option id is the target mode on the Claude bridge.
 */
export function isOptionAboveRung(optionId: string, rung: AutonomyRung, backend: string): boolean {
  if (!optionId) return false;
  const looksLikeMode = isBlanketBypassMode(optionId) || PARTIAL_AUTO_MODES.has(optionId) || /bypass/i.test(optionId);
  if (!looksLikeMode) return false;
  if (/bypass/i.test(optionId) && !BLANKET_BYPASS_MODES.has(optionId)) return true;
  return clampSessionModeForRung(optionId, rung, backend) !== optionId;
}
