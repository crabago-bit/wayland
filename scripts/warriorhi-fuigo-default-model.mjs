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
 * stopped: pass --server-stopped to confirm. A timestamped backup is written
 * next to the file.
 *
 *   node scripts/warriorhi-fuigo-default-model.mjs --data-dir /path/to/data --server-stopped
 *     [--base-url http://127.0.0.1:4000/v1] [--model jarvis-default] [--force] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const opts = {
    dataDir: process.env.DATA_DIR,
    baseUrl: 'http://127.0.0.1:4000/v1',
    model: 'jarvis-default',
    force: false,
    dryRun: false,
    serverStopped: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') opts.dataDir = argv[++i];
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--server-stopped') opts.serverStopped = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.dataDir) throw new Error('--data-dir (or DATA_DIR) is required');
  return opts;
}

const trimUrl = (raw) => (typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '');
const decode = (text) => JSON.parse(decodeURIComponent(Buffer.from(text.trim(), 'base64').toString('latin1')));
const encode = (data) => Buffer.from(encodeURIComponent(JSON.stringify(data)), 'latin1').toString('base64');

function main() {
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

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
