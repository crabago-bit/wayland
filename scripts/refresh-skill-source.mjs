#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Refresh Wayland's own copy of a Claude Code plugin's skills.
 *
 *   node scripts/refresh-skill-source.mjs <plugin-dir> [--data-dir <DATA_DIR>]
 *
 * A laddered Claude session resolves `<plugin>:<skill>` (e.g.
 * `contractor-os:line-item-pricing`) ONLY against
 * `<DATA_DIR>/wayland/skill-sources/<plugin>/skills/<skill>` (see
 * src/process/services/jarvis/ladderedSkillPlugin.ts), never against another
 * app's plugin cache. This copies `<plugin-dir>/skills` there: regular files and
 * directories only (symlinks are skipped), nothing else from the plugin (no
 * hooks, MCP config, commands or agents). It builds the new copy beside the old
 * one and swaps it in, so it is safe to re-run.
 *
 * DATA_DIR defaults to $DATA_DIR, then ~/.wayland-server (the WebUI server's
 * defaults).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node scripts/refresh-skill-source.mjs <plugin-dir> [--data-dir <DATA_DIR>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let pluginDir;
let dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.wayland-server');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--data-dir') dataDir = args[++i] ?? usage('--data-dir needs a value');
  else if (!pluginDir) pluginDir = args[i];
  else usage(`unexpected argument: ${args[i]}`);
}
if (!pluginDir) usage();

const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
const name = manifest.name;
if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
  usage(`plugin name is not a plain directory name: ${JSON.stringify(name)}`);
}
const source = path.join(pluginDir, 'skills');
if (!fs.statSync(source).isDirectory()) usage(`${source} is not a directory`);

const dest = path.join(dataDir, 'wayland', 'skill-sources', name, 'skills');
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

fs.rmSync(staging, { recursive: true, force: true });
copy(source, staging);
if (fs.existsSync(dest)) fs.renameSync(dest, previous);
fs.renameSync(staging, dest);
fs.rmSync(previous, { recursive: true, force: true });

const skills = fs.readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
console.log(`${name}: ${skills} skills (${files} files) -> ${dest}`);
