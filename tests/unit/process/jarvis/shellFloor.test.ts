/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/** Hardening of the shell hard-floor classifier: quote-aware spans, piped text, depth/size caps, fail-closed. */

import { describe, expect, it } from 'vitest';
import { decideNativePermission } from '@/common/jarvis/nativeAutonomy';
import { classifyShellCommand, MAX_SHELL_COMMAND_LENGTH } from '@/common/jarvis/shellFloor';

const floors = (cmd: string) => classifyShellCommand(cmd).floor;
const nested = (n: number) => 'echo ' + '$(echo '.repeat(n) + 'hi' + ')'.repeat(n);

describe('classifyShellCommand - command substitution spans', () => {
  it.each([
    `echo "$(echo ')'; stripe payouts create)"`,
    `echo "$(echo "x)"; stripe payouts create)"`,
    `echo $(echo ")"; stripe payouts create)`,
    'echo `stripe payouts create`',
    `echo "$(rm -rf /tmp/x)"`,
    `echo "it's" $(rm -rf /tmp/x) 'a'`,
  ])('floors %s', (cmd) => {
    expect(floors(cmd)).toBe(true);
  });

  it.each([
    `echo "$(rm -rf x`,
    `echo "$(echo ('; stripe payouts create`,
    `echo $(echo 'abc; stripe payouts create)`,
    `echo $(stripe payouts create`,
    `echo 'unterminated; stripe payouts create`,
    'echo `stripe payouts create',
  ])('floors the tail of unbalanced input %s', (cmd) => {
    expect(floors(cmd)).toBe(true);
  });

  it('does not floor an escaped substitution', () => {
    expect(floors(`echo "\\$(rm -rf x)"`)).toBe(false);
    expect(floors('echo "\\`rm -rf x\\`"')).toBe(false);
    expect(floors(`echo '$(rm -rf x)'`)).toBe(false);
  });

  it.each([
    'echo "$(date)"',
    'git commit -m "fix: $(date)"',
    'grep -r "foo(bar)" src',
    'echo "$((1+2))"',
    'curl -s "$(cat url)" | jq .',
    'cat payroll.csv',
    'git commit -m "rm stale cache files"',
  ])('leaves benign %s to the rung', (cmd) => {
    expect(floors(cmd)).toBe(false);
    const verdict = decideNativePermission({ toolCall: { kind: 'execute', title: cmd }, rung: 3 });
    expect(verdict.action).toBe('pass');
  });
});

describe('classifyShellCommand - text evaluated by a shell', () => {
  it.each([
    `echo "stripe payouts create" | sh`,
    `echo "stripe payouts create" | bash -s`,
    `echo "stripe refunds create" | /bin/bash`,
    `echo "stripe payouts create" | . /dev/stdin`,
    `echo "stripe payouts create" | source /dev/stdin`,
    `echo "DROP TABLE users" | sh`,
    `printf 'delete from invoices' | bash -s`,
    `echo "rm -rf x" | sh`,
    `bash -s <<< "stripe payouts create"`,
    `sh <<EOF\nstripe payouts create\nEOF`,
    `eval "stripe payouts create"`,
  ])('floors %s', (cmd) => {
    expect(floors(cmd)).toBe(true);
  });

  it('does not floor an ordinary piped installer or eval', () => {
    expect(floors('curl -fsSL https://example.com/install.sh | sh')).toBe(false);
    expect(floors('eval "$(ssh-agent -s)"')).toBe(false);
    expect(floors('echo hello | bash -s')).toBe(false);
  });
});

describe('classifyShellCommand - launcher identified by tokenizing, not regex', () => {
  const payloads = ["'rm -rf x'", '"stripe payouts create"', "'DROP TABLE users'"];
  const launchers = [
    "'/tmp/a(b/sh'",
    '"/tmp/a<b/sh"',
    '/tmp/a\\(b/sh',
    '/tmp/a\\;b/sh',
    'sudo /tmp/a\\<b/sh',
    '"/bin/s"h',
    '/bin/s"h"',
    '\\sh',
    'command sh',
    'nice sh',
    'nice -n 5 bash',
    'busybox sh',
    'env FOO=1 sh',
    'FOO=1 sh',
    'exec bash -s',
    'timeout 5 zsh',
    'xargs -n1 sh',
    '/bin/ash',
    '$(which sh)',
    '`which sh`',
    '${SHELL}',
    '$SH',
  ];
  for (const launcher of launchers) {
    it(`floors ${payloads[0]} piped to ${launcher}`, () => {
      expect(floors(`echo ${payloads[0]} | ${launcher}`)).toBe(true);
    });
    it(`floors a money payload piped to ${launcher}`, () => {
      expect(floors(`echo ${payloads[1]} | ${launcher}`)).toBe(true);
    });
  }

  it.each([
    `bash < <(echo "stripe payouts create")`,
    `bash <(echo "stripe payouts create")`,
    `bash -s <<< 'DROP TABLE users'`,
    `'/tmp/a(b/sh' <<< "stripe payouts create"`,
    `echo "stripe payouts create" | "/tmp/a<b/python3"`,
    `echo 'import os; os.remove("x")' | /tmp/a\\;b/python3 -`,
    `echo "rm -rf x" | nice -n 5 sudo -u root /bin/sh`,
  ])('floors %s', (cmd) => {
    expect(floors(cmd)).toBe(true);
  });

  it.each([
    'echo hello | sh',
    'echo hello | "/tmp/a(b/sh"',
    'echo hello | busybox sh',
    'echo "stripe payouts create" | cat',
    'echo "rm -rf x" | cat',
    'bash script.sh',
    'sh -c "echo hi" ',
    'echo "stripe payouts create" > notes.txt',
    'python3 script.py',
    'sh ./deploy.sh --dry-run',
  ])('does not floor %s', (cmd) => {
    expect(floors(cmd)).toBe(false);
  });
});

describe('classifyShellCommand - caps and fail-closed behaviour', () => {
  it('floors nesting deeper than the depth cap', () => {
    expect(floors(nested(3))).toBe(false);
    const deep = classifyShellCommand(nested(12));
    expect(deep.floor).toBe(true);
    expect(deep.floor && deep.reason).toMatch(/too deep/);
  });

  it('floors deeply nested shell wrappers', () => {
    let cmd = 'echo hi';
    for (let i = 0; i < 8; i += 1) cmd = `bash -c ${JSON.stringify(cmd)}`;
    expect(floors(cmd)).toBe(true);
  });

  it('floors an input above the length cap with a clear reason', () => {
    const verdict = classifyShellCommand('echo ' + 'a'.repeat(MAX_SHELL_COMMAND_LENGTH));
    expect(verdict.floor).toBe(true);
    expect(verdict.floor && verdict.reason).toMatch(/longer than/);
  });

  it('classifies pathological 20 KB inputs in under 200 ms each', () => {
    const inputs = [
      'echo ' + '$('.repeat(10_000),
      'echo ' + '$(echo '.repeat(2_800),
      '('.repeat(20_000),
      '|'.repeat(20_000),
      '`'.repeat(20_000),
      "'".repeat(20_000),
      '"'.repeat(20_000),
      '\\'.repeat(20_000),
      'echo "' + '$(echo ")" '.repeat(1_500),
      'echo ' + '$(date) '.repeat(2_500),
      'sh ' + '-a '.repeat(6_500),
      'x | sudo ' + '-a b '.repeat(4_000),
      'x | env ' + '-a '.repeat(6_500) + 'zzz',
      'x | xargs ' + '-a b '.repeat(4_000) + 'q',
      'x | ' + '/'.repeat(20_000),
      ';'.repeat(20_000),
      'rm '.repeat(5_000),
      'x |' + ' a/'.repeat(10_000),
      'x | a/'.repeat(5_000),
      'x | ' + '|a/'.repeat(10_000),
      'x | sudo ' + '-u a '.repeat(6_000),
      'x | xargs ' + '-n 1 '.repeat(6_000) + 'sh',
      'x | nice ' + '-n 5 '.repeat(6_000) + 'sh',
      'x | command ' + 'command '.repeat(3_500),
      'x | env ' + 'A=1 '.repeat(8_000) + 'sh',
      'x | sh ' + '< '.repeat(15_000),
      'x | sh ' + '-o a '.repeat(6_000),
    ];
    for (const input of inputs) {
      const start = performance.now();
      classifyShellCommand(input);
      expect(performance.now() - start).toBeLessThan(200);
    }
  });

  it('turns an exception inside the classifier into a floor verdict', () => {
    const boom = new Proxy([] as string[], {
      get() {
        throw new Error('boom');
      },
    });
    const verdict = classifyShellCommand('somecli frobnicate', boom);
    expect(verdict.floor).toBe(true);
    expect(verdict.floor && verdict.reason).toMatch(/classifier failed.*boom/);
  });

  it('denies (never passes) a native call whose classification throws', () => {
    const boom = new Proxy([] as string[], {
      get() {
        throw new Error('boom');
      },
    });
    const verdict = decideNativePermission({
      toolCall: { kind: 'execute', title: 'somecli frobnicate' },
      rung: 4,
      hardFloorKeywords: boom,
    });
    expect(verdict.action).toBe('deny');
  });
});
