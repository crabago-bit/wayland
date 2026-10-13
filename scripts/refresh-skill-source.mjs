#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Refresh Wayland's own copy of a Claude Code plugin's skills.
 *
 *   DATA_DIR=<data dir> node scripts/refresh-skill-source.mjs <plugin-dir>
 *   node scripts/refresh-skill-source.mjs <plugin-dir> --data-dir <data dir>
 *
 * A laddered Claude session resolves `<plugin>:<skill>` (e.g.
 * `contractor-os:line-item-pricing`) ONLY against
 * `<data dir>/wayland/skill-sources/<plugin>/skills/<skill>` - that is,
 * getDataPath()/skill-sources (src/process/services/jarvis/ladderedSkillPlugin.ts)
 * - never against another app's plugin cache. The data dir is the server's
 * DATA_DIR (on forge-vps: /home/forge/wayland-desktop-data, from the
 * wayland-webui pm2 env); it must be given explicitly so a shell without the
 * server's environment cannot write a copy the server never reads.
 *
 * Only `<plugin-dir>/skills` is copied: regular files and directories (symlinks
 * are skipped), nothing else from the plugin (no hooks, MCP config, commands or
 * agents). A symlinked `skills/` or `plugin.json` is refused. The new copy is
 * built beside the old one and swapped in; on failure the old copy is put back.
 * Safe to re-run.
 */

import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(message);
  console.error('usage: node scripts/refresh-skill-source.mjs <plugin-dir> --data-dir <DATA_DIR>   (or set DATA_DIR)');
  process.exit(2);
}

const args = process.argv.slice(2);
let pluginDir;
let dataDir = process.env.DATA_DIR;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--data-dir') dataDir = args[++i] ?? fail('--data-dir needs a value');
  else if (!pluginDir) pluginDir = args[i];
  else fail(`unexpected argument: ${args[i]}`);
}
if (!pluginDir) fail('missing <plugin-dir>');
if (!dataDir) fail('no data dir: pass --data-dir or set DATA_DIR to the server data dir');

function lstatOrFail(p, kind) {
  let stat;
  try {
    stat = fs.lstatSync(p);
  } catch {
    fail(`${p} does not exist`);
  }
  if (stat.isSymbolicLink()) fail(`${p} is a symlink; refusing`);
  if (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()) fail(`${p} is not a ${kind}`);
}

const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
lstatOrFail(manifestPath, 'file');
const name = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).name;
if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
  fail(`plugin name is not a plain directory name: ${JSON.stringify(name)}`);
}
const source = path.join(pluginDir, 'skills');
lstatOrFail(source, 'dir');

const dest = path.join(path.resolve(dataDir), 'wayland', 'skill-sources', name, 'skills');
const staging = `${dest}.staging-${process.pid}`;
const previous = `${dest}.previous-${process.pid}`;

let files = 0;
function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copy(path.join(from, entry.name), path.join(to, entry.name));
    else if (entry.isFile()) {
      fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
      fs.chmodSync(path.join(to, entry.name), 0o644);
      files++;
    }
  }
}

let retired = false;
try {
  fs.rmSync(staging, { recursive: true, force: true });
  copy(source, staging);
  if (fs.existsSync(dest)) {
    fs.renameSync(dest, previous);
    retired = true;
  }
  try {
    fs.renameSync(staging, dest);
  } catch (error) {
    if (retired) fs.renameSync(previous, dest); // roll back to the old copy
    retired = false;
    throw error;
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
  if (retired) fs.rmSync(previous, { recursive: true, force: true });
}

const skills = fs.readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
console.log(`${name}: ${skills} skills (${files} files) -> ${dest}`);
