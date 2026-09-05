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
 *
 * MATCHING IS ON TOKEN BOUNDARIES, never on substrings. A tool name is a
 * compound of `_`, `-`, `/`, `.`, `:` and camelCase humps, and every one of
 * those is a word boundary. Substring matching read `sign` out of
 * `generate_design` and `get_signed_url`, `pay` out of `list_payments`, `fire`
 * out of `firebase`, `drop` out of `dropbox`, `put` out of `get_tool_inputs`
 * and `book` out of `facebook` - refusals nobody asked for, on tools that
 * change nothing. Whole-token comparison keeps `server__tool` namespacing
 * working (the namespace simply contributes its own tokens) while costing the
 * false positives nothing.
 *
 * THE OPERATOR'S NOTES FILE. `~/.claude/crew-state/autonomy.md` may WIDEN the
 * hard floor, and it does so through ONE machine-readable form:
 *
 *     hard-floor-tokens: wire, payout, docusign
 *
 * or a fenced block tagged `hard-floor`:
 *
 *     ```hard-floor
 *     wire
 *     payout
 *     ```
 *
 * Prose is IGNORED. It used to be parsed, and a sentence like "no first
 * client-facing send on any flow below rung 3" turned into a global ban on
 * every tool named `send` - a floor the operator never wrote, spelled out
 * nowhere, and impossible to reason about from the file. A declared list is the
 * only thing that becomes a rule.
 */

/** 1 SUGGEST, 2 DRAFT->APPROVE, 3 ACT->REPORT, 4 AUTONOMOUS. */
export type AutonomyRung = 1 | 2 | 3 | 4;

/**
 * The rung an agent with NO stored entry sits on: 3, ACT -> REPORT.
 *
 * The blueprint's promotion rule is one rung at a time, so the bottom rung is
 * the honest default for a NEW agent - but there is no creation hook for the
 * rung map, and an absent entry is indistinguishable from a never-configured
 * existing install. Defaulting those to 1 would have meant that shipping this
 * feature silently refused every write tool on every connector for every user
 * who had been running them the day before: an upgrade that breaks working
 * automations without anybody choosing it. So the default is the rung that
 * matches the behaviour those installs already had - acts, and reports - and
 * the hard floor still applies at every rung, including this one. Promotion to
 * 4 and demotion to 1/2 both remain explicit, per-agent decisions.
 */
export const DEFAULT_AUTONOMY_RUNG: AutonomyRung = 3;

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
  // Every valid rung is listed, 1 included. Omitting 1 (which was safe while it
  // was itself the fallback) would silently PROMOTE a deliberately demoted
  // agent the moment the fallback moved off the bottom.
  return n === 1 || n === 2 || n === 3 || n === 4 ? (n as AutonomyRung) : DEFAULT_AUTONOMY_RUNG;
}

/**
 * Split a tool name into whole, comparable tokens.
 *
 * Separators are `_`, `-`, `/`, `.`, `:`, whitespace and camelCase humps, which
 * covers every naming convention MCP servers use in practice, plus the `__`
 * engine namespace (`slack__send_message` -> slack, send, message: the
 * namespace contributes tokens of its own and nothing is lost). Digits stay
 * attached to the word they sit in, so `v2_send` is `v2` + `send`.
 *
 * Camel humps are split so an acronym survives intact: `getHTTPUrl` becomes
 * get, http, url rather than g, e, t, ...
 */
export function tokenizeToolName(toolName: string): string[] {
  if (typeof toolName !== 'string' || toolName.length === 0) return [];
  return (
    toolName
      // An acronym run followed by a Capitalised word ends BEFORE that word's
      // capital: HTTPUrl -> HTTP Url.
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      // An ordinary hump: sendMessage -> send Message.
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter((token) => token.length > 0)
      .map((token) => token.toLowerCase())
  );
}

/**
 * True when `tokens` contains `phrase` - a single token, or a CONTIGUOUS run of
 * them for a multi-word entry like `submit_bid`.
 *
 * Contiguity is the point: a floor entry of `submit_bid` must not fire on
 * `submit_expense_for_bid_review`, which mentions both words and means
 * something else.
 */
function tokensContainPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    let matched = true;
    for (let j = 0; j < phrase.length; j += 1) {
      if (tokens[i + j] !== phrase[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Tokens that mean a tool CHANGES something on the other side of a connector.
 *
 * Read/list/get/search tools do not match, and that is the point: rungs 1 and 2
 * are about withholding effect, not about withholding information. Matching is
 * on the tool NAME only, because the name is the one thing the shim sees for
 * both halves of its job (`tools/list` entries and `tools/call` params) and the
 * one thing a connector cannot rewrite mid-call.
 *
 * The list is deliberately broad on MUTATION verbs. An over-match here costs a
 * refusal the user can lift by promoting one agent one rung; an under-match
 * costs an action nobody approved. The verbs beyond the original set - submit,
 * approve, merge, move, assign, delete, archive, upload, execute, trash,
 * cancel, reply, forward - are all real MCP tool names in the connectors this
 * app ships against, and every one of them changes state.
 */
export const WRITE_TOOL_TOKENS: readonly string[] = [
  'send',
  'create',
  'update',
  'post',
  'write',
  'publish',
  'book',
  'schedule',
  'insert',
  'set',
  'put',
  'patch',
  'submit',
  'approve',
  'merge',
  'move',
  'assign',
  'delete',
  'archive',
  'upload',
  'execute',
  'trash',
  'cancel',
  'reply',
  'forward',
];

/**
 * Tokens that mean a tool only READS.
 *
 * Not a matching rule of its own - it is the invariant that keeps the write
 * list honest, and `autonomy.bun.test.ts` asserts the two sets never intersect.
 * A read-shaped verb must never be able to arrive in `WRITE_TOOL_TOKENS` by a
 * later edit and start refusing directory listings at rung 1.
 */
export const READ_TOOL_TOKENS: readonly string[] = [
  'get',
  'list',
  'search',
  'read',
  'show',
  'fetch',
  'describe',
  'query',
];

const WRITE_TOKEN_SET: ReadonlySet<string> = new Set(WRITE_TOOL_TOKENS);

/**
 * The built-in hard floor: never callable at ANY rung, on ANY connector.
 *
 * This ships in code rather than only in `~/.claude/crew-state/autonomy.md`
 * because a missing or renamed notes file must not silently remove the floor.
 * The file can only ADD to this list, never shrink it.
 *
 * Entries are whole tokens (or, with `_`, contiguous token runs). That is what
 * separates `sign` from `generate_design` and `get_signed_url`, `pay` from
 * `list_payments`, `fire` from `firebase` and `drop` from `dropbox`.
 */
export const DEFAULT_HARD_FLOOR_TOKENS: readonly string[] = [
  'pay',
  'payout',
  'payroll',
  'transfer',
  'refund',
  'delete',
  'remove',
  'destroy',
  'drop',
  'fire',
  'terminate',
  'submit_bid',
  'sign',
  'cancel',
];

/** One floor entry, pre-tokenized. `submit_bid` -> ['submit','bid']. */
function toFloorPhrases(entries: readonly string[]): string[][] {
  const phrases: string[][] = [];
  for (const entry of entries) {
    const tokens = tokenizeToolName(entry);
    if (tokens.length > 0) phrases.push(tokens);
  }
  return phrases;
}

const DEFAULT_HARD_FLOOR_PHRASES = toFloorPhrases(DEFAULT_HARD_FLOOR_TOKENS);

/**
 * Pull hard-floor tokens out of the operator's `autonomy.md`.
 *
 * ONLY two declared forms are read, and prose is ignored entirely:
 *
 *   1. a line `hard-floor-tokens: wire, payout, docusign`
 *   2. a fenced block whose info string mentions `hard-floor`, one entry a line
 *
 * The previous version parsed the WORDS of the prose under a "Hard floor"
 * heading, which turned "no first client-facing send on any flow below rung 3"
 * into a global ban on every `send` tool - a rule the operator never wrote and
 * could not have predicted from reading their own notes. A floor that is not
 * declared is not a floor.
 *
 * Additive only: whatever this returns WIDENS {@link DEFAULT_HARD_FLOOR_TOKENS}
 * and can never shrink it, so an absent or unparseable file weakens nothing.
 */
export function parseHardFloorKeywords(markdown: string): string[] {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];
  const lines = markdown.split(/\r?\n/);
  const raw: string[] = [];
  let fenced = false;

  for (const line of lines) {
    const fence = /^\s*(?:```|~~~)(.*)$/.exec(line);
    if (fence) {
      // Opening a `hard-floor` fence starts collecting; ANY fence while open
      // closes it, so an unrelated block that follows is not swallowed.
      fenced = fenced ? false : /hard[-\s]*floor/i.test(fence[1]);
      continue;
    }
    if (fenced) {
      raw.push(...line.split(/[,;|·]/));
      continue;
    }
    const declared = /^\s*(?:[-*]\s*)?hard[-\s]*floor[-\s]*tokens\s*:(.*)$/i.exec(line);
    if (declared) raw.push(...declared[1].split(/[,;|·]/));
  }

  const tokens = new Set<string>();
  for (const entry of raw) {
    // Keep the entry's own separators so a multi-word entry stays one phrase;
    // `tokenizeToolName` is what decides where the boundaries are.
    const cleaned = entry
      .trim()
      .replace(/^[-*\s]+/, '')
      .trim();
    if (cleaned.length === 0) continue;
    const phrase = tokenizeToolName(cleaned);
    if (phrase.length > 0) tokens.add(phrase.join('_'));
  }
  return [...tokens].toSorted();
}

/** True when `toolName` is on the hard floor - the built-in list or a keyword. */
export function isHardFloorTool(toolName: string, extraKeywords: readonly string[] = []): boolean {
  const tokens = tokenizeToolName(toolName);
  if (tokens.length === 0) return false;
  for (const phrase of DEFAULT_HARD_FLOOR_PHRASES) {
    if (tokensContainPhrase(tokens, phrase)) return true;
  }
  for (const phrase of toFloorPhrases(extraKeywords)) {
    if (tokensContainPhrase(tokens, phrase)) return true;
  }
  return false;
}

/** True when `toolName` looks like it changes state on the far side. */
export function isWriteTool(toolName: string): boolean {
  return tokenizeToolName(toolName).some((token) => WRITE_TOKEN_SET.has(token));
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

/**
 * The effective hard floor, as displayed.
 *
 * `notesFileFound` rather than the notes PATH: this shape is served to remote
 * WebUI callers too, and the file sits in the operator's home directory. The UI
 * only ever needed to say whether the file was found; the path would leak the
 * desktop account name to a paired browser for nothing.
 */
export type HardFloorInfo = {
  /** The built-in floor, as whole tokens. */
  builtinTokens: string[];
  /** Extra tokens declared in the operator's `autonomy.md`. */
  keywords: string[];
  /** Whether `~/.claude/crew-state/autonomy.md` was readable on this machine. */
  notesFileFound: boolean;
};
