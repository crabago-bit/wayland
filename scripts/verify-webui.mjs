#!/usr/bin/env node
// Verify the deploy artifacts are complete BEFORE PM2 restart.
//
// Cheap, deterministic, exits non-zero on any missing file. Intended to run
// after `bun run build:webui` and before `pm2 restart 17`. Catches the exact
// class of regression that broke builtin MCPs on 2026-09-01: server.mjs and
// out/renderer/ are present, but dist-server/ is missing the stdio scripts.
//
// Usage: bun run verify:webui   (exits 0 if healthy, 1 if not)

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CHECKS = [
  { path: 'dist-server/server.mjs',                    minSize: 50_000_000 },
  { path: 'dist-server/gemini.js',                     minSize: 20_000_000 },
  { path: 'dist-server/team-mcp-stdio.js',             minSize: 500_000 },
  { path: 'dist-server/team-guide-mcp-stdio.js',       minSize: 500_000 },
  { path: 'dist-server/builtin-mcp-image-gen.js',      minSize: 10_000_000 },
  { path: 'dist-server/builtin-mcp-search-skills.js',  minSize: 1_000_000 },
  { path: 'dist-server/builtin-mcp-concierge-diag.js', minSize: 500_000 },
  { path: 'dist-server/builtin-mcp-tool-filter.js',    minSize: 1_000 },
  { path: 'out/renderer/index.html',                   minSize: 1_000 },
  { path: 'out/renderer/assets',                       dir: true },
];

let bad = 0;
console.log('[verify:webui] checking artifacts...\n');
for (const c of CHECKS) {
  const abs = path.join(ROOT, c.path);
  if (!existsSync(abs)) { console.error(`  ✗ MISSING     ${c.path}`); bad++; continue; }
  const st = statSync(abs);
  if (c.dir) {
    if (!st.isDirectory()) { console.error(`  ✗ NOT A DIR   ${c.path}`); bad++; continue; }
    console.log(`  ✓ ${c.path}/`);
    continue;
  }
  if (c.minSize && st.size < c.minSize) {
    console.error(`  ✗ TOO SMALL   ${c.path} (${st.size} < ${c.minSize})`);
    bad++;
    continue;
  }
  console.log(`  ✓ ${c.path} (${(st.size/1024/1024).toFixed(1)}MB)`);
}

if (bad) {
  console.error(`\n[verify:webui] FAILED — ${bad} artifact(s) missing or corrupt.`);
  console.error('DO NOT restart PM2. Run `bun run build:webui` and re-verify.');
  process.exit(1);
}
console.log(`\n[verify:webui] OK — safe to \`pm2 restart 17\`.`);
