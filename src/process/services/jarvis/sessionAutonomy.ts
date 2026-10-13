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
 * ACP `_meta` for a LADDERED Claude session: load only PROJECT settings.
 *
 * Claude Code applies its own `permissions.allow` rules, `defaultMode` and
 * hooks from the user's settings and never asks the ACP client about a call
 * those rules allow - ~/.claude/settings.json on this install allows Edit,
 * Write, Bash(curl *), Slack sends and more, so a rung-1 agent could act
 * without Wayland ever seeing it. `settingSources` is the bridge's own option
 * (`_meta.claudeCode.options`, spread into the SDK query), so dropping `user`
 * and `local` removes those rules for this session only:
 *
 *  - credentials are NOT settings: the Max subscription login keeps working
 *    from the unchanged CLAUDE_CONFIG_DIR, nothing is copied or linked;
 *  - `project` stays so Wayland's workspace `.claude/skills` and CLAUDE.md
 *    still load (the gate refuses edits to `.claude/settings*.json`, so an
 *    agent cannot grant itself rules there);
 *  - non-laddered sessions send no `_meta` and are unchanged.
 */
export const LADDERED_CLAUDE_SESSION_META: Readonly<Record<string, unknown>> = Object.freeze({
  claudeCode: { options: { settingSources: ['project'] } },
});

/** The `_meta` a laddered session of `backend` starts with, if any. */
export function ladderedSessionMeta(backend: string): Record<string, unknown> | undefined {
  return backend === 'claude' ? { ...LADDERED_CLAUDE_SESSION_META } : undefined;
}

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
