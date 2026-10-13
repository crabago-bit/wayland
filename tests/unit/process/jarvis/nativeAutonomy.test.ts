/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The autonomy ladder for NATIVE tool calls (shell, edits, deletes, mode
 * switches) and the session-mode clamp. Pure policy - the session layer wires
 * it in through PermissionResolver's gate.
 */

import { describe, expect, it } from 'vitest';
import {
  clampSessionModeForRung,
  decideNativePermission,
  isBlanketBypassMode,
  isOptionAboveRung,
} from '@/common/jarvis/nativeAutonomy';
import type { AutonomyRung } from '@/common/jarvis/autonomy';

const decide = (
  toolCall: { kind?: string; title?: string; rawInput?: unknown },
  rung: AutonomyRung,
  floor: string[] = []
) => decideNativePermission({ toolCall, rung, hardFloorKeywords: floor });

describe('decideNativePermission - hard floor', () => {
  it.each([1, 2, 3, 4] as AutonomyRung[])('denies a delete-kind tool at rung %i', (rung) => {
    const v = decide({ kind: 'delete', title: 'Delete invoices.xlsx' }, rung);
    expect(v.action).toBe('deny');
    expect(v.loggable).toBe(true);
    expect(v.connector).toBe('native');
  });

  it.each([
    'rm -rf ./old-bids',
    'sudo rm /var/data/x.db',
    'find . -name "*.tmp" | xargs rm',
    'find . -name "*.bak" -delete',
    'bash -c "rm -rf build"',
    'cd /tmp && /bin/rm x',
    'git rm docs/old.md',
    'npm rm left-pad',
    'stripe payouts create --amount 100',
    'kubectl delete pod web-1',
    'gh release delete v1',
    'rm -rf ~',
  ])('denies the shell command %s at rung 4', (command) => {
    expect(decide({ kind: 'execute', title: command, rawInput: { command } }, 4).action).toBe('deny');
  });

  it.each([
    'cat payroll.csv',
    'grep -i payment spec.txt',
    'git commit -m "fix signing flow"',
    'docker compose up --remove-orphans',
    'curl https://api.example.com/v1/payments',
    'psql -c "DROP TABLE estimates"',
    'echo "do not rm this"',
  ])('a command that merely MENTIONS a floor word (%s) follows the rung, not the floor', (command) => {
    const at = (rung: AutonomyRung) => decide({ kind: 'execute', title: command, rawInput: { command } }, rung);
    expect(at(1).action).toBe('deny'); // rung 1 refuses every write anyway
    expect(at(2).action).toBe('hold');
    expect(at(3)).toMatchObject({ action: 'pass', loggable: true });
    expect(at(4)).toMatchObject({ action: 'pass', loggable: true });
  });

  it("reads the command, not the agent's prose description", () => {
    const v = decide(
      { kind: 'execute', title: 'ls', rawInput: { command: 'ls -la', description: 'Delete old drafts' } },
      4
    );
    expect(v.action).toBe('pass');
  });

  it('honours operator floor keywords on shell commands', () => {
    expect(
      decide({ kind: 'execute', title: 'wire-cli send', rawInput: { command: 'wire-cli send' } }, 4, ['wire']).action
    ).toBe('deny');
  });

  it('does not floor `docker run --rm` or ordinary commands', () => {
    expect(decide({ kind: 'execute', title: 'docker run --rm alpine true' }, 4).action).toBe('pass');
    expect(decide({ kind: 'execute', title: 'npm test', rawInput: { command: 'npm test' } }, 3).action).toBe('pass');
  });

  it('decides an MCP call on the TOOL half only - a floor word in the server name does not floor it', () => {
    expect(decide({ kind: 'other', title: 'mcp__payroll-db__list_employees' }, 1).action).toBe('pass');
    expect(decide({ kind: 'other', title: 'mcp__delete-me__get_status' }, 4).action).toBe('pass');
  });

  it('a rung-2 MCP write on a SHIMMED server is denied (the shim would refuse it), not held', () => {
    const shimmed = new Set(['warrior-ghl']);
    const call = { kind: 'other', title: 'mcp__warrior-ghl__ghl_create_contact' };
    expect(decideNativePermission({ toolCall: call, rung: 2, shimmedServers: shimmed }).action).toBe('deny');
    expect(decideNativePermission({ toolCall: call, rung: 2 }).action).toBe('hold');
    // At rung 3 the shim records the allowed write; the gate does not double-log it.
    expect(decideNativePermission({ toolCall: call, rung: 3, shimmedServers: shimmed })).toMatchObject({
      action: 'pass',
      loggable: false,
    });
  });

  it('denies a hard-floor MCP tool (backend-loaded connector) at every rung', () => {
    for (const rung of [1, 2, 3, 4] as AutonomyRung[]) {
      const v = decide({ kind: 'other', title: 'mcp__stripe__create_payout' }, rung);
      expect(v.action).toBe('deny');
      expect(v.connector).toBe('stripe');
      expect(v.tool).toBe('stripe__create_payout');
    }
  });
});

describe('decideNativePermission - rungs', () => {
  const edit = { kind: 'edit', title: 'Write /work/proposal.md' };

  it('rung 1 denies a write, rung 2 holds it, rungs 3-4 pass and log it', () => {
    expect(decide(edit, 1).action).toBe('deny');
    expect(decide(edit, 2).action).toBe('hold');
    for (const rung of [3, 4] as AutonomyRung[]) {
      const v = decide(edit, rung);
      expect(v.action).toBe('pass');
      expect(v.loggable).toBe(true);
    }
  });

  it('treats an unknown or missing kind as a write (fail toward asking)', () => {
    expect(decide({ title: 'mystery' }, 2).action).toBe('hold');
    expect(decide({ kind: 'other', title: 'mystery' }, 1).action).toBe('deny');
  });

  it('passes read-shaped kinds at rung 1 without logging', () => {
    for (const kind of ['read', 'search', 'think', 'fetch']) {
      const v = decide({ kind, title: 'x' }, 1);
      expect(v).toMatchObject({ action: 'pass', loggable: false });
    }
  });

  it('an MCP write at rung 2 is held, at rung 1 denied, an MCP read passes', () => {
    expect(decide({ kind: 'other', title: 'mcp__warrior-ghl__ghl_create_contact' }, 2).action).toBe('hold');
    expect(decide({ kind: 'other', title: 'mcp__warrior-ghl__ghl_create_contact' }, 1).action).toBe('deny');
    expect(decide({ kind: 'other', title: 'mcp__warrior-ghl__ghl_search_contact' }, 1).action).toBe('pass');
  });

  it('holds a mode switch below rung 3', () => {
    expect(decide({ kind: 'switch_mode', title: 'Ready to code?' }, 2).action).toBe('hold');
    expect(decide({ kind: 'switch_mode', title: 'Ready to code?' }, 3).action).toBe('pass');
  });
});

describe('clampSessionModeForRung', () => {
  it('never lets rung <= 2 run in a bypass, yolo or full-auto mode', () => {
    for (const rung of [1, 2] as AutonomyRung[]) {
      for (const mode of ['bypassPermissions', 'yolo', 'auto', 'acceptEdits', 'autoGuarded', 'auto_edit']) {
        expect(clampSessionModeForRung(mode, rung, 'claude')).toBe('default');
      }
      expect(clampSessionModeForRung('plan', rung, 'claude')).toBe('plan');
    }
  });

  it('turns a blanket bypass at rung 3-4 into the guarded full-auto, so the floor still applies', () => {
    expect(clampSessionModeForRung('bypassPermissions', 3, 'claude')).toBe('autoGuarded');
    expect(clampSessionModeForRung('bypassPermissions', 4, 'claude')).toBe('autoGuarded');
    // qwen's full-auto IS a blanket bypass -> default.
    expect(clampSessionModeForRung('yolo', 4, 'qwen')).toBe('default');
    expect(clampSessionModeForRung('acceptEdits', 3, 'claude')).toBe('acceptEdits');
  });

  it('pins an unset mode to default (so the CLI settings defaultMode cannot pick a bypass)', () => {
    expect(clampSessionModeForRung(undefined, 4, 'claude')).toBe('default');
  });

  it('identifies blanket bypass modes', () => {
    expect(isBlanketBypassMode('bypassPermissions')).toBe(true);
    expect(isBlanketBypassMode('default')).toBe(false);
  });

  it('withholds mode-switch options above the rung', () => {
    expect(isOptionAboveRung('acceptEdits', 2, 'claude')).toBe(true);
    expect(isOptionAboveRung('bypassPermissions', 4, 'claude')).toBe(true);
    expect(isOptionAboveRung('default', 1, 'claude')).toBe(false);
    expect(isOptionAboveRung('allow_once', 1, 'claude')).toBe(false);
  });
});
