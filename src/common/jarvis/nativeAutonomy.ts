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

/**
 * A delete in COMMAND position: `rm`, `rmdir`, `unlink`, `shred`, optionally
 * behind `sudo`/`xargs`. "Deleting data" is on the hard floor in autonomy.md,
 * and these are the shell's spellings of it. `docker run --rm` does not match:
 * the verb has to start a command, not end a flag.
 */
const SHELL_DELETE = /(?:^|[\s;&|(`])(?:sudo\s+|xargs\s+)?(?:rm|rmdir|unlink|shred)(?:\s|$)/i;

/** Modes that auto-approve EVERYTHING on the agent side, so no request reaches us. */
const BLANKET_BYPASS_MODES: ReadonlySet<string> = new Set(['yolo', 'bypassPermissions', 'auto']);

/** Modes that auto-approve SOME writes (edits) without a human. */
const PARTIAL_AUTO_MODES: ReadonlySet<string> = new Set(['acceptEdits', 'autoEdit', 'auto_edit', 'autoGuarded']);

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
}): NativePermissionVerdict {
  const { toolCall, rung } = input;
  const keywords = input.hardFloorKeywords ?? [];
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : '';
  const title = typeof toolCall.title === 'string' ? toolCall.title.trim() : '';

  // An MCP tool the backend loaded ITSELF (e.g. Claude Code's ~/.claude.json
  // servers) never passes through our shim. When the backend asks permission
  // for it, apply the shim's own verdict to its name here.
  const mcp = MCP_TOOL_TITLE.exec(title);
  if (mcp) {
    const toolName = `${mcp[1]}__${mcp[2]}`;
    const verdict = decideToolCall({ toolName, rung, hardFloorKeywords: keywords });
    const base = { tool: truncate(toolName), connector: mcp[1] };
    if (verdict.decision === 'allowed')
      return { action: 'pass', reason: verdict.reason, loggable: verdict.loggable, ...base };
    // Rung 2 on an MCP write asks a human here - the shim, which cannot ask,
    // refuses the same call. Hard-floor refusals are never held.
    const floor = isHardFloorTool(toolName, keywords);
    return { action: !floor && rung === 2 ? 'hold' : 'deny', reason: verdict.reason, loggable: true, ...base };
  }

  const tool = truncate(`${kind || 'unknown'}: ${title}`);
  const native = { tool, connector: 'native' };

  if (READ_KINDS.has(kind)) {
    return { action: 'pass', reason: 'Read-only tool.', loggable: false, ...native };
  }

  // ── Hard floor ─────────────────────────────────────────────────
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
    if (catastrophic.destructive || SHELL_DELETE.test(command) || isHardFloorTool(command, keywords)) {
      return {
        action: 'deny',
        reason: `Hard floor: ${catastrophic.reason || 'command deletes data or touches a hard-floor action'}; never run by an agent, at any autonomy rung.`,
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
