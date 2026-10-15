#!/usr/bin/env node
/**
 * Point Fuigo's default model (`fuigo.defaultModel`) at the JARVIS tier router.
 *
 * Fuigo serves each OpenAI-compatible provider row as `byok/<provider>/<model>`,
 * and a new Fuigo chat, a scheduled run and a Fuigo teammate all start on
 * `fuigo.defaultModel` when it names a model a connected provider serves (see
 * resolveFuigoNewChatModel / TeamSessionService.resolveDefaultFuigoModel /
 * WorkerTaskManagerJobExecutor). Without it the cutover would carry the old
 * Wayland Core pick over, and with nothing set Fuigo runs `flux-auto`.
 *
 * This sets `fuigo.defaultModel = { id: <row id>, useModel: <model> }` for the
 * enabled provider row whose base URL is the router and which lists the model.
 * The row is never changed and no key is read or written. Run it BEFORE the
 * first 0.13 boot (the cutover migration then keeps it and drops
 * `wcore.defaultModel`), or later with --force.
 *
 * The config store is rewritten whole by the server, so the server must be
 * stopped: pass --server-stopped to confirm. The flag is not trusted on its own:
 * the write is refused while pm2 reports `wayland-webui` online or anything
 * accepts a connection on the WebUI port (127.0.0.1:3403 unless --port says
 * otherwise). --dry-run never writes and so runs with the server up. A
 * timestamped backup is written next to the file.
 *
 *   node scripts/warriorhi-fuigo-default-model.mjs --data-dir /path/to/data --server-stopped
 *     [--base-url http://127.0.0.1:4000/v1] [--model jarvis-default] [--force] [--dry-run]
 *     [--port 3403]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const PM2_APP = 'wayland-webui';

function parseArgs(argv) {
  const opts = {
    dataDir: process.env.DATA_DIR,
    baseUrl: 'http://127.0.0.1:4000/v1',
    model: 'jarvis-default',
    force: false,
    dryRun: false,
    serverStopped: false,
    port: 3403,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') opts.dataDir = argv[++i];
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--server-stopped') opts.serverStopped = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.dataDir) throw new Error('--data-dir (or DATA_DIR) is required');
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('--port must be 1-65535');
  return opts;
}

/** pm2's view of the WebUI app: 'online', another status, or null when pm2 is missing or does not know it. */
function pm2Status() {
  const res = spawnSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 15_000 });
  if (res.error) {
    if (res.error.code === 'ENOENT') return null;
    throw new Error(`pm2 jlist failed: ${res.error.message}`);
  }
  if (res.status !== 0) throw new Error(`pm2 jlist exited ${res.status}`);
  // pm2 may print a banner before the JSON list.
  const start = res.stdout.indexOf('[');
  let list;
  try {
    list = JSON.parse(start >= 0 ? res.stdout.slice(start) : res.stdout);
  } catch {
    throw new Error('pm2 jlist did not return JSON');
  }
  const app = Array.isArray(list) ? list.find((p) => p && p.name === PM2_APP) : undefined;
  return app ? (app.pm2_env?.status ?? 'unknown') : null;
}

/** True when something accepts a TCP connection on 127.0.0.1:<port>. */
function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(2000, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', (error) => done(error.code !== 'ECONNREFUSED'));
  });
}

async function assertServerStopped(port) {
  const status = pm2Status();
  if (status === 'online') throw new Error(`pm2 reports ${PM2_APP} online; stop it first`);
  if (await portListening(port)) throw new Error(`something is listening on 127.0.0.1:${port}; stop the server first`);
}

const trimUrl = (raw) => (typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '');
const decode = (text) => JSON.parse(decodeURIComponent(Buffer.from(text.trim(), 'base64').toString('latin1')));
const encode = (data) => Buffer.from(encodeURIComponent(JSON.stringify(data)), 'latin1').toString('base64');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const file = path.join(opts.dataDir, 'config', 'wayland-config.txt');
  const config = decode(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(config['model.config']) ? config['model.config'] : [];
  const row = rows.find(
    (r) =>
      r &&
      r.enabled !== false &&
      trimUrl(r.baseUrl) === trimUrl(opts.baseUrl) &&
      Array.isArray(r.model) &&
      r.model.includes(opts.model) &&
      r.modelEnabled?.[opts.model] !== false
  );
  if (!row) {
    throw new Error(`no enabled provider row with base URL ${opts.baseUrl} lists ${opts.model}`);
  }
  const next = { id: row.id, useModel: opts.model };
  const current = config['fuigo.defaultModel'];
  console.log(`provider row ${row.id} (${row.name ?? row.platform}) serves ${opts.model}`);
  console.log(`fuigo.defaultModel: ${JSON.stringify(current ?? null)} -> ${JSON.stringify(next)}`);
  if (current && !opts.force && (current.id !== next.id || current.useModel !== next.useModel)) {
    throw new Error('fuigo.defaultModel is already set; pass --force to replace it');
  }
  if (current && current.id === next.id && current.useModel === next.useModel) {
    console.log('already set; nothing to do');
    return;
  }
  if (opts.dryRun) return;
  if (!opts.serverStopped) throw new Error('stop the server first, then pass --server-stopped');
  await assertServerStopped(opts.port);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak-fuigo-default-${stamp}`;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  config['fuigo.defaultModel'] = next;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, encode(config), { mode: 0o600 });
  fs.renameSync(tmp, file);
  console.log(`written (backup ${backup})`);
}

main().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
