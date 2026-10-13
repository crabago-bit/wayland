/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The JARVIS hard floor for SHELL commands: does this command line delete data,
 * move money / sign / pay, or rewrite the agent's own permission settings?
 *
 * Best effort by nature - a shell is Turing complete and a determined payload
 * (a script the agent wrote first, base64, `X=rm; $X f`) is not reachable from a
 * string. The design rule is therefore: when a command can CARRY an action
 * (a wrapper, a shell `-c`, an interpreter `-c/-e`, a database client, an HTTP
 * client with a body), look inside it; only commands that cannot act (cat,
 * grep, ls, ...) and a commit message get the benefit of the doubt for words
 * that merely appear in their arguments. A command that MENTIONS a floor word
 * without doing the thing is not denied here - it follows the rung.
 *
 * Pure, dependency-light (`@/common` only).
 */

import { isHardFloorTool } from './autonomy';

export type ShellFloorVerdict = { floor: false } | { floor: true; reason: string };

const NOT_FLOOR: ShellFloorVerdict = { floor: false };
const floor = (reason: string): ShellFloorVerdict => ({ floor: true, reason });
const TOO_DEEP = 'command nesting is too deep to classify';
/** Longest command line the classifier will examine; longer fails closed. */
export const MAX_SHELL_COMMAND_LENGTH = 32_768;

// ─── Tokenizer ──────────────────────────────────────────────────────────────

/**
 * `quoted`: (part of) the token came from a quoted string. `executes`: a
 * double-quoted part contained `$(` or a backtick - the shell still RUNS that,
 * so the token is never treated as mere data.
 */
type Token = { value: string; quoted: boolean; executes?: boolean };
type Segment = Token[];

/**
 * Split a command line into segments (`;`, `&&`, `||`, `|`, `&`, newline,
 * `$(`, `(`, `)`, backtick) of quote-aware tokens. Quotes are removed from a
 * token's value; `quoted` records that the token came from a quoted string.
 * Redirection operators (`>`, `>>`, `<`) become tokens of their own.
 */
export function tokenizeShell(commandLine: string): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  let executes = false;

  const endWord = () => {
    if (inWord) current.push(executes ? { value: word, quoted, executes } : { value: word, quoted });
    word = '';
    inWord = false;
    quoted = false;
    executes = false;
  };
  const endSegment = () => {
    endWord();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i];
    if (ch === "'") {
      const end = commandLine.indexOf("'", i + 1);
      const stop = end === -1 ? commandLine.length : end;
      word += commandLine.slice(i + 1, stop);
      inWord = true;
      quoted = true;
      i = stop;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < commandLine.length && commandLine[j] !== '"') {
        if (commandLine[j] === '\\' && j + 1 < commandLine.length) {
          word += commandLine[j + 1];
          j += 2;
          continue;
        }
        if (commandLine[j] === '`' || (commandLine[j] === '$' && commandLine[j + 1] === '(')) executes = true;
        word += commandLine[j];
        j += 1;
      }
      inWord = true;
      quoted = true;
      i = j;
      continue;
    }
    if (ch === '\\' && i + 1 < commandLine.length) {
      word += commandLine[i + 1];
      inWord = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (ch === '\n') endSegment();
      else endWord();
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') {
      endSegment();
      continue;
    }
    if (ch === '$' && commandLine[i + 1] === '(') {
      endSegment();
      i += 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      endWord();
      let op = ch;
      if (commandLine[i + 1] === '>') {
        op += '>';
        i += 1;
      }
      current.push({ value: op, quoted: false });
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSegment();
  return segments;
}

const values = (tokens: Token[]): string[] => tokens.map((t) => t.value);
const lower = (value: string | undefined): string => (value ?? '').toLowerCase();
const basename = (value: string): string => value.split('/').pop() ?? value;

// ─── Wrappers ───────────────────────────────────────────────────────────────

/** Flags that take a separate VALUE, per wrapper. Unknown flags are assumed valueless. */
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D', '--user', '--group']),
  doas: new Set(['-u', '-C']),
  xargs: new Set(['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '--class', '--classdata']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  time: new Set(['-f', '-o', '--format', '--output']),
  exec: new Set(['-a']),
  nohup: new Set(),
  command: new Set(),
  builtin: new Set(),
  npx: new Set(['-p', '--package', '--registry', '--cache']),
  bunx: new Set(['-p', '--package']),
  pnpx: new Set(),
  chronic: new Set(),
  flock: new Set(['-w', '--timeout', '-E']),
};

/** Wrappers that take one POSITIONAL before the real command: `timeout 10 rm`, `flock /lock rm`. */
const POSITIONAL_WRAPPERS: ReadonlySet<string> = new Set(['timeout', 'flock']);

const DOCKER_RUN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--env',
  '--env-file',
  '-v',
  '--volume',
  '-w',
  '--workdir',
  '--name',
  '-u',
  '--user',
  '--entrypoint',
  '-p',
  '--publish',
  '--network',
  '--net',
  '-l',
  '--label',
  '--mount',
  '--platform',
  '-h',
  '--hostname',
  '--add-host',
  '--cpus',
  '-m',
  '--memory',
  '--restart',
  '--pull',
  '--cap-add',
  '--cap-drop',
  '--device',
  '--dns',
  '--gpus',
  '--ipc',
  '--pid',
  '--tmpfs',
  '--ulimit',
  '--log-driver',
  '--log-opt',
  '--runtime',
  '--shm-size',
  '--index',
]);

/** Skip leading flags (and the values of value-taking flags) from `start`. */
function skipFlags(words: string[], start: number, valueFlags: ReadonlySet<string>): number {
  let i = start;
  while (i < words.length && words[i].startsWith('-') && words[i] !== '-' && words[i] !== '--') {
    const flag = words[i];
    i += 1;
    if (!flag.includes('=') && valueFlags.has(flag)) i += 1;
  }
  if (words[i] === '--') i += 1;
  return i;
}

/**
 * Strip wrappers until the real command is first: `VAR=1`, sudo, xargs, env,
 * nice, ionice, timeout, stdbuf, time, nohup, npx/bunx/pnpx, `pnpm|yarn dlx`,
 * `bun x`, `npm exec`, `docker run|exec`, `docker compose exec|run`.
 */
function unwrap(tokens: Token[]): Token[] {
  let rest = tokens;
  for (let guard = 0; guard < 16 && rest.length > 0; guard += 1) {
    const words = values(rest);
    const head = basename(lower(words[0]));
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      rest = rest.slice(1);
      continue;
    }
    if (head in WRAPPER_VALUE_FLAGS) {
      let i = skipFlags(words, 1, WRAPPER_VALUE_FLAGS[head]);
      if (head === 'env') while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
      if (POSITIONAL_WRAPPERS.has(head)) i += 1;
      rest = rest.slice(i);
      continue;
    }
    if (/^-?\d+$/.test(words[0]) && rest !== tokens) {
      rest = rest.slice(1); // `nice -10 rm`
      continue;
    }
    const sub = lower(words[1]);
    if ((head === 'pnpm' || head === 'yarn') && sub === 'dlx') {
      rest = rest.slice(skipFlags(words, 2, new Set()));
      continue;
    }
    if ((head === 'bun' && sub === 'x') || (head === 'npm' && (sub === 'exec' || sub === 'x'))) {
      rest = rest.slice(skipFlags(words, 2, new Set(['-p', '--package'])));
      continue;
    }
    if ((head === 'docker' || head === 'podman') && (sub === 'run' || sub === 'exec')) {
      const at = skipFlags(words, 2, DOCKER_RUN_VALUE_FLAGS);
      rest = rest.slice(at + 1); // the image / container
      continue;
    }
    if (
      (head === 'docker' && sub === 'compose' && ['exec', 'run'].includes(lower(words[2]))) ||
      (head === 'docker-compose' && ['exec', 'run'].includes(sub))
    ) {
      const from = head === 'docker' ? 3 : 2;
      const at = skipFlags(words, from, DOCKER_RUN_VALUE_FLAGS);
      rest = rest.slice(at + 1); // the service
      continue;
    }
    break;
  }
  return rest;
}

// ─── Classifiers ────────────────────────────────────────────────────────────

/**
 * The bc8dbb966 delete pattern, kept as an ADDITIONAL deny: `rm`/`rmdir`/
 * `unlink`/`shred` starting any word after a separator. It runs over the
 * command line with the quoted ARGUMENTS of read-only commands and commit
 * messages removed (see `evaluableText`), so `git commit -m "rm stale files"`
 * and `grep -rn "rm -rf" docs` merely mention it.
 */
const SHELL_DELETE = /(?:^|[\s;&|(`])(?:sudo\s+|xargs\s+)?(?:rm|rmdir|unlink|shred)(?:\s|$)/i;

/** The same pattern also matching right after a quote - for text a shell will EVALUATE. */
const SHELL_DELETE_IN_PAYLOAD = /(?:^|[\s;&|(`"'])(?:sudo\s+|xargs\s+)?(?:rm|rmdir|unlink|shred)(?:\s|$)/i;

/** Optional launchers in front of a shell/interpreter: sudo, env, xargs (with flags), a path. */
const LAUNCH = String.raw`(?:sudo\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*)?(?:(?:[^\s;&|()<>]*/)?env\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*)?(?:xargs\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*)?(?:[^\s;&|()<>]*/)?`;

/**
 * A command line that feeds TEXT to a shell to evaluate:
 * `... | sh` / `| /bin/sh` / `| env bash` / `| xargs sh -c`, `eval ...`,
 * `source /dev/stdin` / `. /dev/stdin`, and process substitution
 * `bash <(...)` / `source <(...)`.
 */
const EVALUATES_TEXT = new RegExp(
  String.raw`\|\s*${LAUNCH}(?:ba|z|da|k|fi)?sh\b` +
    String.raw`|(?:^|[\s;&|(])eval\s` +
    String.raw`|(?:^|[\s;&|(])(?:source|\.)\s+/dev/(?:stdin|fd/0)\b` +
    String.raw`|(?:^|[\s;&|(])(?:(?:[^\s;&|()<>]*/)?(?:ba|z|da|k)?sh|source|\.)\s+<\(` +
    String.raw`|(?:^|[\s;&|(])(?:[^\s;&|()<>]*/)?(?:ba|z|da|k|fi)?sh(?:\s+-\S+)*\s*<<`,
  'i'
);

/** Text piped into an interpreter that reads its program from stdin (no script argument, or `-`). */
const PIPED_TO_INTERPRETER = new RegExp(
  String.raw`\|\s*${LAUNCH}(?:python[0-9.]*|node|nodejs|perl|ruby|php)(?:\s+-)?\s*(?:$|[;&|)])`,
  'i'
);

const DELETE_COMMANDS: ReadonlySet<string> = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'wipe']);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS: ReadonlySet<string> = new Set([
  'python',
  'python2',
  'python3',
  'node',
  'nodejs',
  'deno',
  'bun',
  'perl',
  'ruby',
  'php',
  'pwsh',
  'powershell',
]);
const INTERPRETER_CODE_FLAGS: ReadonlySet<string> = new Set([
  '-c',
  '-e',
  '-E',
  '--eval',
  '-r',
  '-p',
  '--print',
  '-Command',
]);
const DB_CLIENTS: ReadonlySet<string> = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'sqlite',
  'mongosh',
  'mongo',
  'duckdb',
  'clickhouse',
  'clickhouse-client',
  'cockroach',
  'sqlcmd',
]);
const HTTP_CLIENTS: ReadonlySet<string> = new Set(['curl', 'wget', 'http', 'https', 'xh', 'httpie']);

/** Commands that cannot act on their own: words in their arguments are only mentions. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'cat',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'less',
  'more',
  'head',
  'tail',
  'ls',
  'wc',
  'echo',
  'printf',
  'stat',
  'file',
  'jq',
  'diff',
  'tree',
  'pwd',
  'which',
]);

/**
 * CLIs whose SUBCOMMAND names the action (`stripe payouts create`, `kubectl
 * delete`, `aws ec2 terminate-instances`). Their leading non-flag words are
 * checked against the floor as well as the command word.
 */
const ACTION_CLIS: ReadonlySet<string> = new Set([
  'stripe',
  'kubectl',
  'gh',
  'aws',
  'gcloud',
  'gsutil',
  'az',
  'heroku',
  'docusign',
  'paypal',
  'square',
  'quickbooks',
  'qbo',
  'plaid',
  'wise',
  'flyctl',
  'vercel',
  'doctl',
]);

/** SQL / document-store statements that destroy data. */
const DATA_DESTROYING_STATEMENT =
  /\b(?:drop\s+(?:table|database|schema|index|view|collection|user)|delete\s+from|truncate(?:\s+table)?\s+\w+|alter\s+table\s+\S+\s+drop)\b|\.(?:drop|dropDatabase|deleteMany|deleteOne|remove|findOneAndDelete)\s*\(|\b(?:flushall|flushdb)\b/i;

/** Interpreter APIs that delete files or data. */
const INTERPRETER_DELETE =
  /\b(?:os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|rmtree|unlinkSync|rmSync|rmdirSync|fs\.(?:promises\.)?(?:rm|unlink|rmdir)|rimraf|FileUtils\.(?:rm|rm_rf|remove)|File\.delete|Remove-Item|\.unlink\s*\(|unlink\s*\(|Path\([^)]*\)\.unlink)/;

/** Money / e-signature providers, by name or API host. */
const MONEY_PROVIDER =
  /\b(?:stripe|paypal|squareup|square|intuit|quickbooks|docusign|plaid|wise|transferwise|braintree|adyen|bank|banking|ach|plaid)\b/i;

/** Actions that move money or bind a signature when aimed at a money provider. */
const MONEY_ACTION =
  /\b(?:create|payouts?|refunds?|transfers?|charges?|capture|payments?|pay|send|sign|envelopes?|invoices?|post|confirm)\b/i;

/** Writing HTTP methods. DELETE is a delete in its own right. */
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function httpMethodOf(head: string, words: string[]): string {
  let method = '';
  let hasBody = false;
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    if (head === 'curl') {
      if (w === '-X' || w === '--request') method = (words[i + 1] ?? '').toUpperCase();
      else if (/^-X[A-Za-z]+$/.test(w)) method = w.slice(2).toUpperCase();
      else if (w.startsWith('--request=')) method = w.slice('--request='.length).toUpperCase();
      else if (
        /^(?:-d|-F|-T|--data|--data-raw|--data-binary|--data-urlencode|--form|--json|--upload-file)(?:=|$)/.test(w)
      )
        hasBody = true;
      else if (w === '-I' || w === '--head') method = method || 'HEAD';
    } else if (head === 'wget') {
      if (w.startsWith('--method=')) method = w.slice('--method='.length).toUpperCase();
      else if (w === '--method') method = (words[i + 1] ?? '').toUpperCase();
      else if (/^--(?:post-data|post-file|body-data|body-file)/.test(w)) hasBody = true;
    } else {
      // httpie / xh: an explicit METHOD word, or `key=value` / `key:=json` items.
      if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(w)) method = w;
      else if (!w.startsWith('-') && /^[^:/=]+:?=/.test(w)) hasBody = true;
    }
  }
  return method || (hasBody ? 'POST' : 'GET');
}

/** Delete / floor verdict for ONE unwrapped segment. `depth` bounds recursion. */
function classifySegment(tokens: Token[], keywords: readonly string[], depth: number): ShellFloorVerdict {
  if (depth > 4) return floor(TOO_DEEP);
  const unwrapped = unwrap(tokens);
  const words = values(unwrapped);
  if (words.length === 0) return NOT_FLOOR;
  const head = basename(lower(words[0]));
  const sub = lower(words[1]);
  const args = words.slice(1);
  const nonFlags = args.filter((w) => !w.startsWith('-'));
  const recurse = (commandLine: string) => classifyShellCommand(commandLine, keywords, depth + 1);

  // ── Plain deletes ───────────────────────────────────────────────
  if (DELETE_COMMANDS.has(head)) return floor('command deletes data');

  // ── Shell -c payloads ───────────────────────────────────────────
  if (SHELLS.has(head)) {
    const at = words.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
    if (at > 0 && words[at + 1] !== undefined) return recurse(words[at + 1]);
    return NOT_FLOOR;
  }

  // ── find -delete / -exec ────────────────────────────────────────
  if (head === 'find') {
    if (args.includes('-delete')) return floor('find -delete deletes data');
    const exec = args.findIndex((w) => w === '-exec' || w === '-execdir' || w === '-ok' || w === '-okdir');
    if (exec >= 0) {
      const tail = args.slice(exec + 1);
      const end = tail.findIndex((w) => w === ';' || w === '\\;' || w === '+');
      const inner = (end === -1 ? tail : tail.slice(0, end)).map((value) => ({ value, quoted: false }));
      return classifySegment(inner, keywords, depth + 1);
    }
    return NOT_FLOOR;
  }

  // ── Version control / packages / containers / cloud ────────────
  if (head === 'git') {
    if (sub === 'rm' || sub === 'clean') return floor(`git ${sub} deletes data`);
    if (
      sub === 'push' &&
      args.some(
        (w) => /^(?:-f|--force|--force-with-lease|--delete|-d|--mirror|--prune)(?:=|$)/.test(w) || /^\+|^:/.test(w)
      )
    )
      return floor('git push --force/--delete destroys remote history');
    if (sub === 'branch' && args.some((w) => w === '-D' || w === '-d' || w === '--delete'))
      return floor('git branch delete');
    return NOT_FLOOR;
  }
  if (PACKAGE_MANAGERS.has(head) && ['rm', 'remove', 'uninstall', 'un', 'r'].includes(sub)) {
    return floor(`${head} ${sub} removes data`);
  }
  if (head === 'docker' || head === 'podman' || head === 'docker-compose') {
    const verbs = nonFlags.map(lower);
    if (verbs.some((v) => v === 'rm' || v === 'rmi' || v === 'prune')) return floor(`${head} removal`);
    if (verbs.includes('down') && args.some((w) => w === '-v' || w === '--volumes' || w === '--rmi'))
      return floor(`${head} down removes volumes/images`);
    return NOT_FLOOR;
  }
  if (head === 'rsync' && args.some((w) => /^--(?:delete|remove-source-files)/.test(w))) {
    return floor('rsync --delete deletes data');
  }
  if (head === 'aws' && sub === 's3' && ['rm', 'rb'].includes(lower(words[2])))
    return floor('aws s3 rm/rb deletes data');
  if (head === 'gsutil' && ['rm', 'rb'].includes(sub)) return floor('gsutil rm/rb deletes data');
  if (head === 'redis-cli' && args.some((w) => /^(?:flushall|flushdb|del|unlink)$/i.test(w))) {
    return floor('redis-cli deletes data');
  }

  // ── Database clients: inspect the statement ────────────────────
  if (DB_CLIENTS.has(head) || (head === 'cockroach' && sub === 'sql')) {
    if (DATA_DESTROYING_STATEMENT.test(args.join(' '))) return floor(`${head} statement destroys data`);
    return NOT_FLOOR;
  }

  // ── Interpreters with inline code ──────────────────────────────
  if (INTERPRETERS.has(head)) {
    const at = args.findIndex((w) => INTERPRETER_CODE_FLAGS.has(w));
    const code = at >= 0 ? (args[at + 1] ?? '') : '';
    if (!code) return NOT_FLOOR;
    if (INTERPRETER_DELETE.test(code) || DATA_DESTROYING_STATEMENT.test(code))
      return floor(`${head} code deletes data`);
    if (MONEY_PROVIDER.test(code) && MONEY_ACTION.test(code)) return floor(`${head} code moves money or signs`);
    // Inline code that shells out: look at the strings it carries.
    for (const literal of code.match(/(["'])(?:(?!\1).)+\1/g) ?? []) {
      const inner = recurse(literal.slice(1, -1));
      if (inner.floor) return inner;
    }
    return NOT_FLOOR;
  }

  // ── HTTP clients: method + target ──────────────────────────────
  if (HTTP_CLIENTS.has(head)) {
    const method = httpMethodOf(head, words);
    if (method === 'DELETE') return floor(`${head} DELETE request`);
    if (WRITE_METHODS.has(method)) {
      const urls = args.filter((w) => /^(?:https?:\/\/|[\w.-]+\.[a-z]{2,}\/)/i.test(w));
      // A target whose host is a variable or command substitution
      // (`"$STRIPE_URL/v1/refunds"`) cannot be resolved here: check the part
      // that IS visible - its path. If that is clean, the call is an ordinary
      // write and follows the rung.
      for (const w of args) {
        const visible = /^(?:\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*)(\/.*)$/.exec(w)?.[1];
        if (visible && isHardFloorTool(visible.replace(/[^A-Za-z0-9]+/g, '_'), keywords)) {
          return floor(`${head} ${method} to a hard-floor endpoint`);
        }
      }
      for (const url of urls) {
        if (MONEY_PROVIDER.test(url)) return floor(`${head} ${method} to a money / signing API`);
        let path = url;
        try {
          path = new URL(url.includes('://') ? url : `https://${url}`).pathname;
        } catch {
          // keep the raw string
        }
        if (isHardFloorTool(path.replace(/[^A-Za-z0-9]+/g, '_'), keywords)) {
          return floor(`${head} ${method} to a hard-floor endpoint`);
        }
      }
    }
    return NOT_FLOOR;
  }

  // ── Action CLIs and the command word itself ────────────────────
  if (READ_ONLY_COMMANDS.has(head)) return NOT_FLOOR;
  const parts = [head];
  if (ACTION_CLIS.has(head)) {
    for (const w of args) {
      if (w.startsWith('-') || !/^[A-Za-z][A-Za-z0-9_:.-]*$/.test(w)) break;
      parts.push(w);
      if (parts.length >= 4) break;
    }
    // Any `delete-*`/`remove-*`/`terminate-*` style subcommand is a delete.
    if (parts.slice(1).some((p) => /^(?:delete|remove|destroy|terminate|purge|rm|rb)(?:[-_].*)?$/i.test(p))) {
      return floor(`${parts.join(' ')} deletes data`);
    }
  }
  if (isHardFloorTool(parts.join('_'), keywords)) return floor(`${parts.join(' ')} is a hard-floor action`);
  return NOT_FLOOR;
}

/**
 * The inner command of every `$(...)` and backtick span OUTSIDE single quotes
 * (double quotes do not stop the shell from running them). Nested spans are
 * found by the recursive classification of each inner command.
 *
 * One quote-aware pass, linear in the input: a `)` inside quotes does not close
 * a span. Anything unbalanced or oddly quoted yields the whole remaining tail
 * as a command too (fail closed).
 */
function commandSubstitutions(commandLine: string): string[] {
  const out: string[] = [];
  const n = commandLine.length;
  // 'S' = an open `$(` / `(` (command context), 'D' = an open double quote.
  const stack: string[] = [];
  let parens = 0;
  let spanStart = 0;
  for (let i = 0; i < n; i += 1) {
    const ch = commandLine[i];
    const top = stack[stack.length - 1];
    if (ch === '\\') {
      i += 1;
    } else if (ch === "'" && top !== 'D') {
      const end = commandLine.indexOf("'", i + 1);
      if (end === -1) {
        // An unterminated quote is not valid shell: treat what follows as code.
        if (parens === 0) out.push(commandLine.slice(i + 1));
        break;
      }
      i = end;
    } else if (ch === '"') {
      if (top === 'D') stack.pop();
      else stack.push('D');
    } else if (ch === '`') {
      let end = i + 1;
      while (end < n && commandLine[end] !== '`') end += commandLine[end] === '\\' ? 2 : 1;
      if (parens === 0) out.push(commandLine.slice(i + 1, Math.min(end, n)));
      i = end;
    } else if (ch === '$' && commandLine[i + 1] === '(') {
      if (parens === 0) spanStart = i + 2;
      parens += 1;
      stack.push('S');
      i += 1;
    } else if (ch === '(' && top === 'S') {
      parens += 1;
      stack.push('S');
    } else if (ch === ')' && top === 'S') {
      parens -= 1;
      stack.pop();
      if (parens === 0) out.push(commandLine.slice(spanStart, i));
    }
  }
  if (parens > 0) out.push(commandLine.slice(spanStart));
  return out;
}

/** True for a segment whose quoted arguments are only data: a read-only command or a commit/tag message. */
function quotesAreData(segment: Segment): boolean {
  const words = values(unwrap(segment));
  const head = basename(lower(words[0]));
  if (READ_ONLY_COMMANDS.has(head)) return true;
  return head === 'git' && ['commit', 'tag', 'notes'].includes(lower(words[1]));
}

/**
 * The command line as the shell would run it, with the quoted arguments of
 * read-only commands and commit messages left out. Everything else - a
 * `bash -c "..."` payload included - is kept, unquoted, so the delete pattern
 * sees it at a word boundary.
 */
function evaluableText(segments: Segment[]): string {
  return segments
    .map((segment) => {
      // A quoted token that runs a command substitution is never just data.
      const keep = quotesAreData(segment) ? segment.filter((t) => !t.quoted || t.executes) : segment;
      return values(keep).join(' ');
    })
    .join(' ; ');
}

/**
 * Does `commandLine` hit the hard floor? Checks the raw delete pattern, then
 * every segment (recursing into wrappers, `-c` payloads, find -exec and
 * interpreter code). Fails closed: an oversized command, nesting past the depth
 * cap, or any error inside the classifier is a floor verdict.
 */
export function classifyShellCommand(
  commandLine: string,
  keywords: readonly string[] = [],
  depth: number = 0
): ShellFloorVerdict {
  if (depth > 0) return classifyChecked(commandLine, keywords, depth);
  if (commandLine && commandLine.length > MAX_SHELL_COMMAND_LENGTH) {
    return floor(`command is longer than ${MAX_SHELL_COMMAND_LENGTH} characters and cannot be classified`);
  }
  try {
    return classifyChecked(commandLine, keywords, depth);
  } catch (error) {
    return floor(`shell classifier failed (${error instanceof Error ? error.message : String(error)}); denied`);
  }
}

function classifyChecked(commandLine: string, keywords: readonly string[], depth: number): ShellFloorVerdict {
  if (!commandLine) return NOT_FLOOR;
  if (depth > 6) return floor(TOO_DEEP);
  // Text piped into a shell or eval'd is code, quotes and all.
  if (EVALUATES_TEXT.test(commandLine)) {
    if (SHELL_DELETE_IN_PAYLOAD.test(commandLine)) return floor('command deletes data');
    if (DATA_DESTROYING_STATEMENT.test(commandLine)) return floor('text evaluated by a shell destroys data');
    if (MONEY_PROVIDER.test(commandLine) && MONEY_ACTION.test(commandLine)) {
      return floor('text evaluated by a shell moves money or signs');
    }
  }
  if (PIPED_TO_INTERPRETER.test(commandLine)) {
    if (SHELL_DELETE_IN_PAYLOAD.test(commandLine) || INTERPRETER_DELETE.test(commandLine)) {
      return floor('code piped into an interpreter deletes data');
    }
    if (DATA_DESTROYING_STATEMENT.test(commandLine)) return floor('code piped into an interpreter destroys data');
    if (MONEY_PROVIDER.test(commandLine) && MONEY_ACTION.test(commandLine)) {
      return floor('code piped into an interpreter moves money or signs');
    }
  }
  // `$(...)` / backticks run even inside double quotes: classify each as a command.
  for (const inner of commandSubstitutions(commandLine)) {
    const verdict = classifyShellCommand(inner, keywords, depth + 1);
    if (verdict.floor) return verdict;
  }
  const segments = tokenizeShell(commandLine);
  if (SHELL_DELETE.test(evaluableText(segments))) return floor('command deletes data');
  for (const segment of segments) {
    const verdict = classifySegment(segment, keywords, depth);
    if (verdict.floor) return verdict;
  }
  return NOT_FLOOR;
}

/** Claude Code's project/local/user settings files - where permission rules live. */
const SETTINGS_FILE = /settings(?:\.local)?\.json\b/i;
const CLAUDE_DIR = /(?:^|[\s\\/"'=>:])\.claude(?:[\\/]|\b)/i;

/**
 * True when a shell command could WRITE a `.claude/settings*.json` file:
 * redirection, cp/mv/tee/install/ln/dd/sed -i, an interpreter, or anything
 * else that is not a pure read. `cat .claude/settings.json` stays allowed.
 */
export function shellWritesAgentSettings(commandLine: string): boolean {
  if (!commandLine || !SETTINGS_FILE.test(commandLine) || !CLAUDE_DIR.test(commandLine)) return false;
  for (const segment of tokenizeShell(commandLine)) {
    const words = values(unwrap(segment));
    const head = basename(lower(words[0]));
    if (!head) continue;
    if (segment.some((t) => !t.quoted && (t.value === '>' || t.value === '>>'))) return true;
    if (head === 'cd' || READ_ONLY_COMMANDS.has(head)) continue;
    if (head === 'find' && !words.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint)/.test(w))) continue;
    if (head === 'git' && ['diff', 'log', 'show', 'status'].includes(lower(words[1]))) continue;
    return true;
  }
  return false;
}
