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
 * in the settings UI; it is not enforced on them.) An UNREADABLE rung store is
 * different: we cannot tell whether this agent was configured, so it is put on
 * the ladder at `STORAGE_FAILURE_RUNG` (2) - fail toward asking.
 */

import { autonomyAgentKey, toAutonomyRung, type AutonomyRung } from '@/common/jarvis/autonomy';
import { decideNativePermission, isOptionAboveRung } from '@/common/jarvis/nativeAutonomy';
import type { PermissionGate, PermissionGateVerdict } from '@process/acp/session/PermissionResolver';
import type { ToolFilterSpawnAutonomy } from '@process/services/mcpServices/builtinMcpRuntime';
import { ProcessConfig } from '@process/utils/initStorage';
import { appendApprovalTo, type ApprovalRecord } from './approvalsLog';
import { resolveApprovalsLogPath } from './approvalsPath';
import { STORAGE_FAILURE_RUNG } from './autonomySettings';
import { readHardFloorKeywords } from './hardFloor';

/**
 * The ladder snapshot for one agent, or `undefined` when the agent has no
 * configured rung (today's behaviour).
 */
export async function resolveConfiguredSpawnAutonomy(agent: {
  backend: string;
  customAgentId?: string;
}): Promise<ToolFilterSpawnAutonomy | undefined> {
  const key = autonomyAgentKey(agent);
  let rung: AutonomyRung;
  try {
    const stored = (await ProcessConfig.get('agents.autonomy')) as Record<string, unknown> | undefined;
    if (!stored || !Object.prototype.hasOwnProperty.call(stored, key)) return undefined;
    rung = toAutonomyRung(stored[key]);
  } catch {
    rung = STORAGE_FAILURE_RUNG;
  }
  return {
    agent: key,
    rung,
    hardFloorKeywords: readHardFloorKeywords(),
    logPath: resolveApprovalsLogPath(),
  };
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
  } = {}
): PermissionGate {
  const append = deps.append ?? appendApprovalTo;
  const internal = new Set(deps.internalMcpServers ?? []);
  const isInternalTool = (title: string | null | undefined): boolean => {
    const match = /^(?:mcp__)?(.+?)__[A-Za-z0-9_-]+$/.exec((title ?? '').trim());
    return match !== null && internal.has(match[1]);
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
        return {
          action: 'hold',
          options,
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
