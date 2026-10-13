/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #998 - the executable half of the per-tool filtering shim.
 *
 * Spawned in the real MCP server's place. Two upstream shapes:
 *
 *   node builtin-mcp-tool-filter.js --allow alpha --allow beta -- <command> [args...]
 *   node builtin-mcp-tool-filter.js --allow-all --rung 2 --url https://host/mcp
 *
 * The engine ALWAYS talks to this process over stdio. Upstream is either the
 * real server's own stdio (a child of this process) or, for a hosted connector,
 * an HTTP transport this process opens. Everything relays untouched except the
 * two exceptions {@link createToolFilter} owns.
 *
 * WHY THE HTTP LEG EXISTS. A rung and a hard floor are rules about `tools/call`,
 * and no engine wire carries either - which is why the stdio path interposes at
 * all. Hosted connectors were handed to the engine as raw URLs, so the engine
 * connected to them DIRECTLY and neither the rung nor the floor applied, while
 * the settings card promised the floor held "on any connector". A promise the
 * enforcement layer does not keep is worse than no promise: it is the reason
 * somebody stops checking. So the shim bridges - it is the stdio server the
 * engine sees, and the HTTP client the hosted server sees, with the SAME
 * `decideToolCall` verdict in between. The engine still spawns this process and
 * hands it the URL on argv and the headers in its environment; the adversary
 * the ladder is written against is the MODEL, which sees only the tools this
 * shim lists and the refusals it returns.
 *
 * Bundled by `scripts/build-mcp-servers.js` into a self-contained CJS file, so
 * it imports nothing outside node builtins and its one sibling module - a
 * packaged build runs it from `app.asar.unpacked` where there is no ASAR
 * require() patching.
 *
 * FAILURE POSTURE. Upstream death kills this process with the upstream's own
 * exit code, so the engine sees "the server is gone" - exactly what it would
 * see on a direct connection, and what its reconnect logic keys on. A shim that
 * outlived its server and answered errors forever would be strictly worse,
 * because the engine would never retry. A malformed argv is a startup failure,
 * not a pass-through: refusing to start cannot leak tools, while starting
 * unfiltered would.
 */

import { spawn } from 'node:child_process';

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { toAutonomyRung, type AutonomyRung } from '@/common/jarvis/autonomy';
import { appendApprovalTo, type ApprovalRecord } from '@process/services/jarvis/approvalsLog';
import { createToolFilter, type JsonRpcMessage } from './toolFilterShim';

/**
 * Env var carrying the hosted connector's request headers, as a JSON object.
 *
 * NOT argv: headers are where a hosted connector's bearer token lives, and argv
 * is world-readable through `ps` on every platform this ships on. The env of a
 * process is readable by its owner too, but it is not printed by the tool every
 * user reaches for first.
 */
export const SHIM_HEADERS_ENV = 'WAYLAND_TOOL_FILTER_HEADERS';

/**
 * Env var carrying a hosted connector's URL when the shim is given `--url-env`.
 * A URL can embed a key in its path or query, and argv is readable from `ps`.
 */
export const SHIM_URL_ENV = 'WAYLAND_TOOL_FILTER_URL';

/** Which wire the shim uses to reach the real server. */
export type ShimUpstreamKind = 'stdio' | 'http' | 'sse';

export type ShimArgv = {
  /** Exact per-tool selection. Empty only when `allowAll` is set. */
  allowed: string[];
  /** `--allow-all`: no per-tool selection, the shim is here for the ladder. */
  allowAll: boolean;
  /** `--rung N`. Absent means no ladder is enforced for this connector. */
  rung?: AutonomyRung;
  /** `--agent <key>`: whose ladder, recorded on every ledger line. */
  agent: string;
  /** `--floor <keyword>`, repeatable. Additive to the built-in hard floor. */
  hardFloorKeywords: string[];
  /** `--log <path>`: absolute path of approvals.jsonl, resolved by the host. */
  logPath?: string;
  /** How to reach upstream. `stdio` spawns `command`; the rest open `url`. */
  upstream: ShimUpstreamKind;
  /** Hosted connector endpoint. Set iff `upstream !== 'stdio'`. */
  url?: string;
  /** Upstream stdio command. Set iff `upstream === 'stdio'`. */
  command?: string;
  args: string[];
};

/**
 * Parse
 *   `[--allow <tool> ... | --allow-all] [--rung N] [--agent <key>]
 *    [--floor <keyword> ...] [--log <path>]
 *    ( --url <endpoint> [--upstream http|streamable_http|sse] | -- cmd args... )`.
 *
 * One tool per flag, NOT a delimited list. A comma-joined list would be a
 * fail-OPEN bug: MCP does not forbid a comma in a tool name, and a tool called
 * `a,b` would split into two entries, admitting `a` and `b` when neither was
 * ever allowed. There is no delimiter here to corrupt.
 *
 * Exactly ONE upstream must be named. `--url` and a `--` command together is a
 * malformed invocation, not a precedence question to answer quietly: the caller
 * meant one connector and we would silently enforce against the other.
 *
 * The `--` separator is load-bearing on the stdio leg: everything after it is
 * the upstream argv and is never re-interpreted. Spawning uses an argv array
 * with no shell, so a server command containing shell metacharacters is inert.
 *
 * Only http(s) URLs are accepted. A `file:` or `data:` endpoint reaching a fetch
 * in this process is not a connector, and the parser is the cheapest place to
 * say so.
 *
 * Returns null when the shape is wrong. The caller must then FAIL, never fall
 * back to running unfiltered.
 */
export function parseShimArgv(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ShimArgv | null {
  const sep = argv.indexOf('--');
  // No `--` at all is legal now: a hosted connector has no upstream argv.
  const head = sep === -1 ? argv.slice() : argv.slice(0, sep);
  const tail = sep === -1 ? [] : argv.slice(sep + 1);

  const allowed: string[] = [];
  const hardFloorKeywords: string[] = [];
  let allowAll = false;
  let rung: AutonomyRung | undefined;
  let agent = '';
  let logPath: string | undefined;
  let url: string | undefined;
  let upstreamFlag: string | undefined;

  for (let i = 0; i < head.length; i += 1) {
    const flag = head[i];
    if (flag === '--allow-all') {
      allowAll = true;
      continue;
    }
    if (flag === '--url-env') {
      // The URL itself travels in the environment; `--url-env` with nothing
      // there is malformed, never "no upstream".
      const fromEnv = env[SHIM_URL_ENV];
      if (!fromEnv) return null;
      url = fromEnv;
      continue;
    }
    if (
      flag !== '--allow' &&
      flag !== '--rung' &&
      flag !== '--agent' &&
      flag !== '--floor' &&
      flag !== '--log' &&
      flag !== '--url' &&
      flag !== '--upstream'
    ) {
      continue;
    }
    const value = head[i + 1];
    // A trailing value-taking flag with no value is a malformed invocation, not
    // an empty entry to skip over.
    if (value === undefined) return null;
    i += 1;
    if (value.length === 0) continue;
    switch (flag) {
      case '--allow':
        allowed.push(value);
        break;
      case '--rung':
        rung = toAutonomyRung(value);
        break;
      case '--agent':
        agent = value;
        break;
      case '--floor':
        hardFloorKeywords.push(value.toLowerCase());
        break;
      case '--log':
        logPath = value;
        break;
      case '--url':
        url = value;
        break;
      case '--upstream':
        upstreamFlag = value.toLowerCase();
        break;
    }
  }
  // An empty allowlist without `--allow-all` is a caller bug - the app withholds
  // the connector entirely in that case, so the shim should never be spawned for
  // it.
  if (allowed.length === 0 && !allowAll) return null;

  const base = { allowed, allowAll, rung, agent, hardFloorKeywords, logPath };

  if (url !== undefined) {
    // One upstream, named once.
    if (tail.length > 0) return null;
    if (upstreamFlag !== undefined && !UPSTREAM_KINDS.has(upstreamFlag)) return null;
    if (!isHttpUrl(url)) return null;
    // `streamable_http` and `http` are the same wire under two names in the
    // stored transport type; only SSE is a different client.
    const upstream: ShimUpstreamKind = upstreamFlag === 'sse' ? 'sse' : 'http';
    return { ...base, upstream, url, args: [] };
  }

  if (tail.length === 0) return null;
  return { ...base, upstream: 'stdio', command: tail[0], args: tail.slice(1) };
}

/** Accepted values of `--upstream`. Anything else is a malformed invocation. */
const UPSTREAM_KINDS: ReadonlySet<string> = new Set(['http', 'streamable_http', 'sse']);

/** Only real HTTP endpoints. A `file:`/`data:` "connector" is not one. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Request headers for the hosted leg, read from {@link SHIM_HEADERS_ENV}.
 *
 * A malformed value yields NO headers rather than a crash: the connector will
 * then fail its own auth and say so, which is a better failure than a shim that
 * refuses to start and looks like the ladder broke.
 */
export function readUpstreamHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env[SHIM_HEADERS_ENV];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[name] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Split a stdio stream into newline-delimited JSON messages.
 *
 * MCP stdio framing is one JSON value per line. A line that does not parse is
 * dropped rather than relayed: forwarding a half-frame would corrupt the peer's
 * parser, and there is nothing useful to pass on.
 */
export function createLineReader(onMessage: (message: JsonRpcMessage) => void): (chunk: Buffer | string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            onMessage(parsed as JsonRpcMessage);
          }
        } catch {
          // Not a frame we can act on; dropping beats corrupting the peer.
        }
      }
      index = buffer.indexOf('\n');
    }
  };
}

/**
 * The upstream half of the shim, whichever wire it is on.
 *
 * `send` is what {@link createToolFilter} calls as `sendToUpstream`, so the
 * verdict path is IDENTICAL for a stdio child and a hosted connector - there is
 * one `decideToolCall` and one refusal, and nothing about the transport can
 * reach it.
 */
export type UpstreamLink = {
  send: (message: JsonRpcMessage) => void;
  close: () => void;
};

/** The slice of an MCP SDK client transport this bridge uses. */
export type UpstreamTransport = {
  start: () => Promise<void>;
  send: (message: unknown) => Promise<void>;
  close: () => Promise<void>;
  onmessage?: (message: unknown) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
};

export type HttpUpstreamOptions = {
  url: string;
  kind: 'http' | 'sse';
  headers?: Record<string, string>;
  /** Relayed toward the engine, after {@link createToolFilter} sees it. */
  onMessage: (message: JsonRpcMessage) => void;
  /** The connection is gone. The shim exits, exactly as it does on child death. */
  onClose: (reason: string) => void;
  /** Test seam. Production builds the SDK transport for `kind`. */
  createTransport?: (options: HttpUpstreamOptions) => UpstreamTransport;
};

function defaultTransport(options: HttpUpstreamOptions): UpstreamTransport {
  const url = new URL(options.url);
  const requestInit = options.headers ? { headers: options.headers } : undefined;
  const transport =
    options.kind === 'sse'
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  return transport as unknown as UpstreamTransport;
}

/**
 * Open the hosted leg and return the sink the filter writes to.
 *
 * Messages the engine sends before the transport has finished starting are
 * QUEUED, not dropped. The engine opens with `initialize` the moment it has a
 * pipe, and an MCP handshake that loses its first frame does not recover - it
 * waits forever for a reply to a request nobody received.
 *
 * The queue is CAPPED at {@link PRE_START_QUEUE_LIMIT}. A handshake needs a
 * handful of frames; a queue still growing past that means the transport is not
 * coming up, and holding every frame the engine sends in the meantime turns a
 * connector that will never connect into unbounded memory in a process that is
 * about to be killed anyway. Overflow is dropped with a stderr line, which is
 * the same visibility the send-failure path gets.
 *
 * A send that rejects is reported on stderr and otherwise swallowed. The engine
 * is already waiting on its own request timeout for that id, and inventing a
 * JSON-RPC error here would race the transport's own reply if the send actually
 * landed.
 */
/**
 * How many pre-start frames are held. An MCP handshake is `initialize` plus
 * `notifications/initialized` plus the engine's first `tools/list`; 64 is far
 * more headroom than that and still a bound.
 */
export const PRE_START_QUEUE_LIMIT = 64;

export function connectHttpUpstream(options: HttpUpstreamOptions): UpstreamLink {
  const transport = (options.createTransport ?? defaultTransport)(options);
  let ready = false;
  let closed = false;
  const pending: JsonRpcMessage[] = [];

  transport.onmessage = (message: unknown) => {
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      options.onMessage(message as JsonRpcMessage);
    }
  };
  transport.onerror = (error: Error) => {
    // Silence after close: tearing the connection down ABORTS whatever was in
    // flight, and reporting each abort as an upstream error makes an orderly
    // shutdown look like a fault.
    if (closed) return;
    process.stderr.write(`[wayland-tool-filter] upstream error: ${error.message}\n`);
  };
  transport.onclose = () => {
    if (closed) return;
    closed = true;
    options.onClose('upstream closed the connection');
  };

  const deliver = (message: JsonRpcMessage): void => {
    void transport.send(message).catch((error: unknown) => {
      if (closed) return;
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[wayland-tool-filter] upstream send failed: ${detail}\n`);
    });
  };

  // Started in the background so the link exists BEFORE the caller wires stdin.
  // Anything the engine says in the meantime lands in `pending`.
  void transport
    .start()
    .then(() => {
      ready = true;
      while (pending.length > 0) deliver(pending.shift() as JsonRpcMessage);
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (closed) return;
      closed = true;
      options.onClose(`upstream failed to connect: ${detail}`);
    });

  return {
    send: (message) => {
      if (closed) return;
      if (ready) {
        deliver(message);
        return;
      }
      if (pending.length >= PRE_START_QUEUE_LIMIT) {
        process.stderr.write(
          `[wayland-tool-filter] upstream still starting; dropping frame beyond ${PRE_START_QUEUE_LIMIT} queued\n`
        );
        return;
      }
      pending.push(message);
    },
    close: () => {
      closed = true;
      void transport.close().catch(() => {
        // Closing a connection that is already gone is not an error worth
        // reporting - we are on our way out either way.
      });
    },
  };
}

/* c8 ignore start - process wiring is covered by the packaged smoke, not unit tests */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const parsed = parseShimArgv(argv);
  if (!parsed) {
    process.stderr.write(
      '[wayland-tool-filter] usage: (--allow <tool> ... | --allow-all) [--rung N] [--agent <key>]\n' +
        '[wayland-tool-filter]        [--floor <keyword> ...] [--log <path>]\n' +
        '[wayland-tool-filter]        ( --url <endpoint> [--upstream http|streamable_http|sse]\n' +
        '[wayland-tool-filter]        | -- <command> [args...] )\n' +
        '[wayland-tool-filter] refusing to start; running unfiltered would expose tools the user switched off\n'
    );
    process.exit(2);
    return;
  }

  const toEngine = (message: JsonRpcMessage) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const logPath = parsed.logPath;
  const autonomy =
    parsed.rung === undefined
      ? undefined
      : {
          agent: parsed.agent,
          rung: parsed.rung,
          hardFloorKeywords: parsed.hardFloorKeywords,
          // No `--log` means no ledger, not a crash: the ladder still refuses,
          // it simply is not written down.
          onDecision: logPath ? (record: ApprovalRecord) => appendApprovalTo(logPath, record) : undefined,
        };

  if (parsed.upstream === 'stdio') {
    const child = spawn(parsed.command as string, parsed.args, { stdio: ['pipe', 'pipe', 'inherit'], shell: false });
    const filter = createToolFilter({
      allowed: parsed.allowed,
      allowAll: parsed.allowAll,
      autonomy,
      sendToEngine: toEngine,
      sendToUpstream: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    });

    process.stdin.on('data', createLineReader(filter.fromEngine));
    child.stdout.on('data', createLineReader(filter.fromUpstream));

    // Upstream death is propagated, never swallowed.
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    child.on('error', (err) => {
      process.stderr.write(`[wayland-tool-filter] upstream failed to start: ${err.message}\n`);
      process.exit(1);
    });
    process.stdin.on('end', () => child.stdin.end());
    return;
  }

  // Hosted connector. Same filter, same verdict; only the pipe differs. The
  // link is created BEFORE the filter so `sendToUpstream` can close over it, and
  // it queues internally until the transport has started.
  let link: UpstreamLink | undefined;
  const filter = createToolFilter({
    allowed: parsed.allowed,
    allowAll: parsed.allowAll,
    autonomy,
    sendToEngine: toEngine,
    sendToUpstream: (message) => link?.send(message),
  });

  link = connectHttpUpstream({
    url: parsed.url as string,
    kind: parsed.upstream,
    headers: readUpstreamHeaders(),
    onMessage: filter.fromUpstream,
    // Exiting non-zero on a dead connection is the SAME failure posture as the
    // stdio leg: the engine sees "the server is gone", which is what its
    // reconnect logic keys on. A shim that outlived its connector and answered
    // errors forever would never be retried.
    onClose: (reason) => {
      process.stderr.write(`[wayland-tool-filter] ${reason}\n`);
      process.exit(1);
    },
  });

  process.stdin.on('data', createLineReader(filter.fromEngine));
  // The engine closing stdin IS the shutdown signal on the hosted leg - there is
  // no child process whose exit would carry us out. Close the transport, then
  // exit deliberately: an open HTTP/SSE connection keeps the event loop alive,
  // so a shim that only closed the link would linger as an orphan for as long
  // as the socket took to notice, one per connector per session.
  process.stdin.on('end', () => {
    link?.close();
    process.exit(0);
  });
}

if (require.main === module) main();
/* c8 ignore stop */
