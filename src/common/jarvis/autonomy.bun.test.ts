/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// src/common/jarvis/autonomy.bun.test.ts
// Run with: bun test src/common/jarvis/autonomy.bun.test.ts
//
// The ladder's MATCHING rules, which is where its false positives and its false
// negatives both live. A hard floor that refuses `generate_design` because the
// letters `sign` appear in it is not a floor, it is noise the operator learns to
// route around; a write pattern that misses `submit_expense` is a rung that
// silently does nothing.

import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_AUTONOMY_RUNG,
  READ_TOOL_TOKENS,
  WRITE_TOOL_TOKENS,
  decideToolCall,
  isHardFloorTool,
  isWriteTool,
  parseHardFloorKeywords,
  toAutonomyRung,
  tokenizeToolName,
} from './autonomy';

describe('tokenizeToolName', () => {
  it('splits on every separator a tool name uses, including the __ namespace', () => {
    expect(tokenizeToolName('slack__send_message')).toEqual(['slack', 'send', 'message']);
    expect(tokenizeToolName('cal-com/create.event')).toEqual(['cal', 'com', 'create', 'event']);
    expect(tokenizeToolName('mcp__server__tool')).toEqual(['mcp', 'server', 'tool']);
  });

  it('splits camelCase and keeps acronyms whole', () => {
    expect(tokenizeToolName('getSignedUrl')).toEqual(['get', 'signed', 'url']);
    expect(tokenizeToolName('getHTTPUrl')).toEqual(['get', 'http', 'url']);
  });

  it('keeps digits attached to their word', () => {
    expect(tokenizeToolName('v2_send')).toEqual(['v2', 'send']);
  });
});

describe('hard floor matches whole tokens, never substrings', () => {
  // Every one of these was a REAL false positive of the old substring pattern.
  const mustNotFloor = [
    'figma__generate_design',
    'clickup__assign_task',
    'drive__get_signed_url',
    'weave__get_tool_inputs',
    'apollo__list_payments',
    'stripe__payload_inspect',
    'firebase__read_doc',
    'dropbox__list_files',
    'notion__get_notebook',
    'meta__facebook_page_insights',
  ];
  for (const name of mustNotFloor) {
    it(`does not floor ${name}`, () => {
      expect(isHardFloorTool(name)).toBe(false);
    });
  }

  const mustFloor = [
    'docusign__sign',
    'gusto__run_payroll',
    'stripe__create_refund',
    'bank__transfer_funds',
    'gmail__delete_message',
    'erpnext__submit_bid',
    'admin__terminate_instance',
    'db__drop_table',
    'hr__fire_employee',
  ];
  for (const name of mustFloor) {
    it(`floors ${name}`, () => {
      expect(isHardFloorTool(name)).toBe(true);
    });
  }

  it('matches a multi-word floor entry only as a CONTIGUOUS run', () => {
    expect(isHardFloorTool('erp__submit_bid')).toBe(true);
    // Mentions both words, means something else.
    expect(isHardFloorTool('erp__submit_expense_for_bid_review')).toBe(false);
  });

  it('applies operator keywords on the same token boundaries', () => {
    expect(isHardFloorTool('bank__wire_funds', ['wire'])).toBe(true);
    // `wire` must not fire on `wireframe`, which is the whole point.
    expect(isHardFloorTool('figma__create_wireframe', ['wire'])).toBe(false);
  });
});

describe('write-tool detection', () => {
  const writes = [
    'erpnext__submit_invoice',
    'clickup__approve_task',
    'github__merge_pull_request',
    'clickup__move_task',
    'clickup__assign_task',
    'gmail__archive_thread',
    'drive__upload_file',
    'weave__execute_tool',
    'gmail__reply',
    'gmail__forward',
    'slack__send_message',
    'apollo__update_contact',
  ];
  for (const name of writes) {
    it(`treats ${name} as a write`, () => {
      expect(isWriteTool(name)).toBe(true);
    });
  }

  const reads = [
    'slack__read_channel',
    'erpnext__list_items',
    'gmail__get_message',
    'apollo__search_contacts',
    'ahrefs__describe_index',
    'db__query_rows',
    'ui__show_panel',
    'http__fetch_url',
    // `put` used to match this via substring; `book` used to match a notebook.
    'weave__get_tool_inputs',
    'notion__get_notebook',
  ];
  for (const name of reads) {
    it(`treats ${name} as a read`, () => {
      expect(isWriteTool(name)).toBe(false);
    });
  }

  it('never lets a read-shaped verb become a write verb', () => {
    const writeSet = new Set(WRITE_TOOL_TOKENS);
    for (const token of READ_TOOL_TOKENS) {
      expect(writeSet.has(token)).toBe(false);
    }
  });
});

describe('parseHardFloorKeywords reads DECLARED tokens only', () => {
  it('ignores prose, including the sentence that used to ban every send tool', () => {
    const markdown = [
      '## Hard floor',
      '',
      'No first client-facing send on any flow below rung 3. Never move money.',
      '',
    ].join('\n');
    expect(parseHardFloorKeywords(markdown)).toEqual([]);
  });

  it('reads a hard-floor-tokens line', () => {
    expect(parseHardFloorKeywords('hard-floor-tokens: wire, payout, docusign')).toEqual(['docusign', 'payout', 'wire']);
  });

  it('reads the line when it is a bullet, and is case-insensitive', () => {
    expect(parseHardFloorKeywords('- Hard-Floor-Tokens: Wire; Payout')).toEqual(['payout', 'wire']);
  });

  it('reads a fenced hard-floor block, one entry a line', () => {
    const markdown = ['Some prose about the floor.', '', '```hard-floor', 'wire', 'submit_bid', '```', ''].join('\n');
    expect(parseHardFloorKeywords(markdown)).toEqual(['submit_bid', 'wire']);
  });

  it('does not swallow an unrelated fenced block that follows', () => {
    const markdown = ['```hard-floor', 'wire', '```', '', '```bash', 'rm -rf /', '```'].join('\n');
    expect(parseHardFloorKeywords(markdown)).toEqual(['wire']);
  });

  it('returns nothing for an empty or non-string file', () => {
    expect(parseHardFloorKeywords('')).toEqual([]);
    expect(parseHardFloorKeywords(undefined as unknown as string)).toEqual([]);
  });
});

describe('rung coercion', () => {
  it('keeps every valid rung, 1 included', () => {
    for (const rung of [1, 2, 3, 4]) {
      expect(toAutonomyRung(rung)).toBe(rung as 1 | 2 | 3 | 4);
      expect(toAutonomyRung(String(rung))).toBe(rung as 1 | 2 | 3 | 4);
    }
  });

  it('falls back to the default for anything else', () => {
    for (const value of [0, 5, -1, 'x', null, undefined, {}]) {
      expect(toAutonomyRung(value)).toBe(DEFAULT_AUTONOMY_RUNG);
    }
  });

  it('defaults an unconfigured agent to ACT -> REPORT, not to SUGGEST', () => {
    // Existing installs must not lose every write tool the day this ships.
    expect(DEFAULT_AUTONOMY_RUNG).toBe(3);
  });
});

describe('decideToolCall order', () => {
  it('lets the hard floor outrank rung 4', () => {
    expect(decideToolCall({ toolName: 'gusto__run_payroll', rung: 4 }).decision).toBe('refused');
  });

  it('no longer refuses a design tool at rung 4 because of the letters in it', () => {
    expect(decideToolCall({ toolName: 'figma__generate_design', rung: 4 }).decision).toBe('allowed');
  });

  it('refuses a newly-recognised mutation verb at rung 2', () => {
    expect(decideToolCall({ toolName: 'clickup__approve_task', rung: 2 }).decision).toBe('refused');
  });
});
