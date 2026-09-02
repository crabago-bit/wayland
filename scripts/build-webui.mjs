#!/usr/bin/env node
// Full WebUI deploy build: renderer + server bundle + stdio MCP scripts.
//
// Why this exists: `bun run build:server` alone produces server.mjs + gemini.js
// only. The 6 stdio MCP scripts (team-mcp-stdio, builtin-mcp-*, tool-filter)
// come from a SEPARATE step (`scripts/build-mcp-servers.js`) that writes to
// `out/main/`, not `dist-server/`. If you skip the copy, Wayland boots but the
// mcpScriptCanary logs FAILED every restart and every stdio builtin is dead —
// this is exactly what happened after the 2026-09-01 v0.11.18 → v0.12.5 upgrade.
//
// Usage: bun run build:webui
// Optional: WAYLAND_ALLOW_MISSING_MCP=1 to skip @wayland/{imap,news,cal-com,apple}-mcp
//           when the sibling waylandmcp monorepo isn't cloned (matches prior builds).

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Canonical list — MUST match MCP_STDIO_SCRIPT_NAMES in src/process/utils/mcpScriptDir.ts.
// If either list changes without the other, the canary catches it at boot but the
// deploy is already broken; keep this synced when upstream adds scripts.
const MCP_STDIO_SCRIPTS = [
  'team-mcp-stdio.js',
  'team-guide-mcp-stdio.js',
  'builtin-mcp-image-gen.js',
  'builtin-mcp-search-skills.js',
  'builtin-mcp-concierge-diag.js',
  'builtin-mcp-tool-filter.js',
];

const step = (n, msg) => console.log(`\n[build:webui ${n}/4] ${msg}`);

function run(cmd, env = {}) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
}

step(1, 'Renderer (out/renderer/)');
// NODE_OPTIONS: v8 heap OOMs at ~2GB on the vendor-arco / vendor-editor chunks
// under electron-vite 0.12.5+. 8GB matches the typecheck script's setting.
run('bunx electron-vite build', { NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=8192' });

step(2, 'Server bundle (dist-server/server.mjs + gemini.js)');
run('node scripts/build-server.mjs');

step(3, 'Stdio MCP servers (out/main/*.js)');
// Optional @wayland/*-mcp packages need the sibling waylandmcp repo; without it
// the script fails hard by design (#940). WAYLAND_ALLOW_MISSING_MCP=1 downgrades
// those to warnings so the required scripts still build. Matches prior VPS builds.
run('node scripts/build-mcp-servers.js', { WAYLAND_ALLOW_MISSING_MCP: '1' });

step(4, `Copy ${MCP_STDIO_SCRIPTS.length} MCP scripts out/main → dist-server`);
const missing = [];
for (const name of MCP_STDIO_SCRIPTS) {
  const src = path.join(ROOT, 'out/main', name);
  const dst = path.join(ROOT, 'dist-server', name);
  if (!existsSync(src)) { missing.push(name); continue; }
  copyFileSync(src, dst);
  const size = (statSync(dst).size / 1024).toFixed(0);
  console.log(`  ✓ ${name} (${size}K)`);
}
if (missing.length) {
  console.error(`\n[build:webui] FAILED — ${missing.length} MCP scripts missing after build:`);
  for (const n of missing) console.error(`  ✗ ${n}`);
  console.error(`\nRun \`bun run verify:webui\` to see the full artifact state.`);
  process.exit(1);
}

console.log('\n[build:webui] done. Run `bun run verify:webui` before PM2 restart.');
