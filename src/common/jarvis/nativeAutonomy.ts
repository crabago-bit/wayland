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

/** Commands that delete files when they are the command word of a segment. */
const DELETE_COMMANDS: ReadonlySet<string> = new Set(['rm', 'rmdir', 'unlink', 'shred']);

/**
 * `<tool> rm ...` forms. autonomy.md puts "deleting data" on the hard floor and
 * does not carve out version-control or package-manager removals, so these stay
 * denied: `git rm` deletes tracked files; `npm rm` & co. are kept for the same
 * reason (the safer reading), even though they only uninstall a dependency.
 */
const DELETE_SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun']);

/** Words that only wrap the real command: `sudo rm`, `xargs rm`, `env X=1 rm`. */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'xargs',
  'env',
  'time',
  'nice',
  'nohup',
  'command',
  'exec',
]);

/** Shells whose `-c` argument is itself a command line. */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash']);

/**
 * CLIs whose SUBCOMMAND names the action (`stripe payouts create`, `kubectl
 * delete`, `gh release delete`). For these the leading non-flag words are
 * checked against the floor as well as the command word.
 */
const SUBCOMMAND_CLIS: ReadonlySet<string> = new Set([
  'stripe',
  'kubectl',
  'gh',
  'aws',
  'gcloud',
  'az',
  'heroku',
  'docusign',
  'paypal',
  'square',
  'quickbooks',
  'qbo',
]);

/** Split a command line into `;`/`&&`/`||`/`|`/newline/`$(`/backtick segments, as word lists. */
function commandSegments(commandLine: string, keepQuotedText: boolean): string[][] {
  const text = keepQuotedText
    ? commandLine.replace(/["']/g, ' ')
    : commandLine.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ');
  return text
    .split(/;|&&|\|\||\||\n|\$\(|`|\(|\)/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
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

/** Drop leading wrappers and `VAR=value` assignments; strip a leading path. */
function unwrap(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) i += 1;
    else if (COMMAND_WRAPPERS.has(word.toLowerCase())) {
      i += 1;
      // A wrapper's own flags (`xargs -0`, `sudo -u x`) are not the command.
      while (i < words.length && words[i].startsWith('-')) i += 1;
    } else break;
  }
  return words.slice(i).map((word, index) => (index === 0 ? (word.split('/').pop() ?? word) : word));
}

/** True when any segment's command word deletes data. Quoted text is KEPT so `bash -c "rm x"` is seen. */
function deletesData(commandLine: string): boolean {
  for (const raw of commandSegments(commandLine, true)) {
    let words = unwrap(raw);
    // `bash -c "rm x"`: the -c payload (quotes already dropped) is the command.
    const dashC = words.indexOf('-c');
    if (words[0] && SHELLS.has(words[0].toLowerCase()) && dashC > 0) words = unwrap(words.slice(dashC + 1));
    const [head, sub] = [words[0]?.toLowerCase(), words[1]?.toLowerCase()];
    if (!head) continue;
    if (DELETE_COMMANDS.has(head)) return true;
    if (DELETE_SUBCOMMAND_TOOLS.has(head) && (sub === 'rm' || sub === 'remove' || sub === 'uninstall')) {
      return head === 'git' ? sub === 'rm' : true;
    }
    if (head === 'find' && words.includes('-delete')) return true;
  }
  return false;
}

/**
 * True when a segment's COMMAND (its command word, plus the subcommand words of
 * a known action CLI) is a hard-floor action. Quoted strings are removed first,
 * so a commit message, a grep pattern or a file name that merely MENTIONS a
 * floor word does not trip the floor; such calls fall through to the rung.
 */
function commandIsOnFloor(commandLine: string, keywords: readonly string[]): boolean {
  for (const raw of commandSegments(commandLine, false)) {
    const words = unwrap(raw);
    const head = words[0];
    if (!head) continue;
    if (SHELLS.has(head.toLowerCase())) continue; // its -c payload was stripped with the quotes
    const parts = [head];
    if (SUBCOMMAND_CLIS.has(head.toLowerCase())) {
      for (const word of words.slice(1)) {
        if (word.startsWith('-') || !/^[A-Za-z][A-Za-z0-9_:-]*$/.test(word)) break;
        parts.push(word);
        if (parts.length >= 4) break;
      }
    }
    if (isHardFloorTool(parts.join('_'), keywords)) return true;
  }
  return false;
}

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
    // The floor/delete checks read the COMMAND itself, never the agent's prose
    // `description` ("Delete the old drafts") that rides along in rawInput.
    const shell = shellCommandOf(toolCall, title);
    const deletes = deletesData(shell);
    if (catastrophic.destructive || deletes || commandIsOnFloor(shell, keywords)) {
      const why = catastrophic.reason || (deletes ? 'command deletes data' : 'command is a hard-floor action');
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
