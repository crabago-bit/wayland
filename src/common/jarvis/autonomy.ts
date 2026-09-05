/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The JARVIS autonomy ladder - the shared, dependency-free policy every layer
 * agrees on.
 *
 * WHY IT LIVES IN `common`. Three processes have to reach the SAME verdict for
 * the same tool name: the settings UI (which explains what a rung will do), the
 * host (which decides whether to interpose the filtering shim at all), and the
 * shim itself (which is the only one that can actually refuse a `tools/call`).
 * A second copy of the write-pattern or the hard floor would drift, and drift
 * here is fail-OPEN: the UI would promise a refusal the shim never makes.
 *
 * This module imports NOTHING - not electron, not node. The shim is bundled as
 * a self-contained CJS file that runs from `app.asar.unpacked`, so anything it
 * transitively pulls in has to survive that bundle.
 */

/** 1 SUGGEST, 2 DRAFT->APPROVE, 3 ACT->REPORT, 4 AUTONOMOUS. */
export type AutonomyRung = 1 | 2 | 3 | 4;

/**
 * New agents start at SUGGEST. The blueprint's promotion rule is one rung at a
 * time after a flow has been boring to watch, so the default has to be the
 * bottom - anything else silently promotes every agent that has never run.
 */
export const DEFAULT_AUTONOMY_RUNG: AutonomyRung = 1;

export const AUTONOMY_RUNGS: readonly AutonomyRung[] = [1, 2, 3, 4];

/** Short name of each rung, as the blueprint names them. */
export const AUTONOMY_RUNG_LABELS: Record<AutonomyRung, string> = {
  1: 'SUGGEST',
  2: 'DRAFT → APPROVE',
  3: 'ACT → REPORT',
  4: 'AUTONOMOUS',
};

/** One-line description of what each rung permits. */
export const AUTONOMY_RUNG_DESCRIPTIONS: Record<AutonomyRung, string> = {
  1: 'Recommends only. Write tools are refused; you do it.',
  2: 'Drafts and asks. Write tools are refused until you approve and send.',
  3: 'Acts on reversible work and reports after. Write tools allowed.',
  4: 'Runs end to end, logged rather than asked. Write tools allowed.',
};

/** Coerce anything persisted or read off the wire into a valid rung. */
export function toAutonomyRung(value: unknown): AutonomyRung {
  const n = typeof value === 'number' ? value : Number(value);
  return n === 2 || n === 3 || n === 4 ? (n as AutonomyRung) : DEFAULT_AUTONOMY_RUNG;
}

/**
 * A tool that CHANGES something on the other side of a connector.
 *
 * Read/list/get/search tools do not match, and that is the point: rungs 1 and 2
 * are about withholding effect, not about withholding information. Matching is
 * on the tool NAME only, because the name is the one thing the shim sees for
 * both halves of its job (`tools/list` entries and `tools/call` params) and the
 * one thing a connector cannot rewrite mid-call.
 */
export const WRITE_TOOL_PATTERN = /send|create|update|post|write|publish|book|schedule|insert|set_|put|patch/i;

/**
 * The built-in hard floor: never callable at ANY rung, on ANY connector.
 *
 * This ships in code rather than only in `~/.claude/crew-state/autonomy.md`
 * because a missing or renamed notes file must not silently remove the floor.
 * The file can only ADD to this list, never shrink it.
 */
export const DEFAULT_HARD_FLOOR_PATTERN =
  /pay|payout|payroll|transfer|refund|delete|remove|destroy|drop|fire|terminate|submit_bid|sign|cancel/i;

/**
 * Pull hard-floor keywords out of the operator's `autonomy.md`.
 *
 * The file states the floor as a prose line under a "Hard floor" heading, with
 * phrases separated by `·` (or `,` / `;`). We take each phrase's WORDS as
 * keywords, because a tool name is `slack__send_message`, never
 * "first client-facing send on any flow below rung 3".
 *
 * Deliberately additive and deliberately loose: over-matching here costs a
 * refusal the operator can lift by editing one word, while under-matching costs
 * an action nobody approved.
 */
export function parseHardFloorKeywords(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const collected: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/hard\s*floor/i.test(lines[i])) continue;
    // The keywords may be on the heading line itself (after a dash) or on the
    // first non-empty line beneath it.
    const inline = lines[i].replace(/^#+\s*/, '').replace(/hard\s*floor/i, '');
    const body = inline.replace(/^[\s—–-]+/, '').trim();
    const source = body.length > 0 ? body : (lines.slice(i + 1).find((l) => l.trim().length > 0) ?? '');
    collected.push(source);
  }
  const words = new Set<string>();
  for (const source of collected) {
    for (const phrase of source.split(/[·,;|]/)) {
      for (const raw of phrase.split(/\s+/)) {
        const word = raw.toLowerCase().replace(/[^a-z]/g, '');
        // Short and structural words ("on", "any", "no") would match half the
        // tool namespace, so they are dropped rather than floored.
        if (word.length >= 4 && !HARD_FLOOR_STOPWORDS.has(word)) words.add(word);
      }
    }
  }
  return [...words].toSorted();
}

/** Prose glue from the operator's notes that must never become a match rule. */
const HARD_FLOOR_STOPWORDS: ReadonlySet<string> = new Set([
  'never',
  'autonomous',
  'exceptions',
  'below',
  'rung',
  'flow',
  'first',
  'change',
  'orders',
  'statements',
  'data',
  'money',
  'public',
  'legal',
  'placing',
  'moving',
  'client',
  'facing',
  'floor',
  'hard',
  'with',
  'that',
  'this',
  'from',
  'into',
  'over',
  'under',
  'when',
  'only',
  'other',
  'and',
]);

/** True when `toolName` is on the hard floor - the built-in pattern or a keyword. */
export function isHardFloorTool(toolName: string, extraKeywords: readonly string[] = []): boolean {
  if (DEFAULT_HARD_FLOOR_PATTERN.test(toolName)) return true;
  const lowered = toolName.toLowerCase();
  return extraKeywords.some((keyword) => keyword.length > 0 && lowered.includes(keyword));
}

/** True when `toolName` looks like it changes state on the far side. */
export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOL_PATTERN.test(toolName);
}

/**
 * The connector half of an engine-namespaced tool name (`server__tool`).
 * Returns `''` when the name carries no namespace - the shim logs the empty
 * string rather than guessing a connector it was never told.
 */
export function connectorOfToolName(toolName: string): string {
  const index = toolName.indexOf('__');
  return index > 0 ? toolName.slice(0, index) : '';
}

export type AutonomyDecision = {
  decision: 'allowed' | 'refused';
  /** Why, in the words the refusal message uses. */
  reason: string;
  /** Whether this call is worth a line in approvals.jsonl. */
  loggable: boolean;
};

/**
 * The single verdict function. Order is load-bearing: the hard floor is checked
 * FIRST, so rung 4 cannot buy past it.
 *
 * Read/list/get/search tools fall through to `allowed` at every rung and are
 * not logged - the ledger is about effect and about refusals, and burying both
 * under every directory listing would make it unreadable.
 */
export function decideToolCall(input: {
  toolName: string;
  rung: AutonomyRung;
  hardFloorKeywords?: readonly string[];
}): AutonomyDecision {
  const { toolName, rung } = input;

  if (isHardFloorTool(toolName, input.hardFloorKeywords ?? [])) {
    return {
      decision: 'refused',
      reason: `Hard floor: ${toolName} is never callable by an agent, at any autonomy rung.`,
      loggable: true,
    };
  }

  if (rung <= 2 && isWriteTool(toolName)) {
    return {
      decision: 'refused',
      reason: `Requires approval (autonomy rung ${rung}). Draft it and ask.`,
      loggable: true,
    };
  }

  if (isWriteTool(toolName)) {
    return { decision: 'allowed', reason: `Write tool allowed at autonomy rung ${rung}.`, loggable: true };
  }

  return { decision: 'allowed', reason: 'Read-only tool.', loggable: false };
}
