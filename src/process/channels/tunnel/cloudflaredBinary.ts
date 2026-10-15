/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve the path to a usable `cloudflared` binary.
 *
 * Resolution order:
 *   1. A `cloudflared` already on PATH (use it as-is).
 *   2. A binary we previously downloaded into the app data dir.
 *   3. Lazily download the correct per-platform binary from cloudflare's
 *      official GitHub releases, chmod +x it, and use that.
 *
 * The download is LAZY: it only happens when a tunnel is actually requested,
 * never at module load or app boot.
 *
 * SECURITY: cloudflared opens a public ingress. This module only resolves the
 * binary; the decision to spawn it is gated by the caller behind an explicit
 * opt-in flag. We pin downloads to cloudflare's own GitHub release host over
 * https and verify the downloaded file is non-empty + executable.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';
import { appDataDir } from '@process/utils/appPaths';

/**
 * cloudflare's stable "latest" release download endpoint. GitHub redirects
 * `/releases/latest/download/<asset>` to the newest tagged asset, so we never
 * pin a version that goes stale.
 */
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

/**
 * Per-platform asset descriptor.
 *
 * macOS assets are gzip-compressed tarballs (`.tgz`) that contain a single
 * `cloudflared` binary; linux and windows assets are raw binaries.
 */
type AssetSpec = {
  /** Asset file name on the cloudflare release. */
  asset: string;
  /** Whether the asset is a `.tgz` that must be extracted. */
  archive: boolean;
  /** Final binary file name written to the bin dir. */
  binName: string;
};

/**
 * Map `${process.platform}-${process.arch}` to the matching release asset.
 * Asset names verified against cloudflare/cloudflared releases.
 */
function resolveAssetSpec(platform: NodeJS.Platform, arch: string): AssetSpec | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') return { asset: 'cloudflared-darwin-arm64.tgz', archive: true, binName: 'cloudflared' };
    if (arch === 'x64') return { asset: 'cloudflared-darwin-amd64.tgz', archive: true, binName: 'cloudflared' };
    return null;
  }
  if (platform === 'linux') {
    if (arch === 'x64') return { asset: 'cloudflared-linux-amd64', archive: false, binName: 'cloudflared' };
    if (arch === 'arm64') return { asset: 'cloudflared-linux-arm64', archive: false, binName: 'cloudflared' };
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return { asset: 'cloudflared-windows-amd64.exe', archive: false, binName: 'cloudflared.exe' };
    return null;
  }
  return null;
}

/**
 * Directory we download managed binaries into. Uses the Electron userData dir
 * when available (main process), falling back to `~/.wayland/bin` for headless
 * / test contexts where `electron` is not importable.
 */
async function resolveBinDir(): Promise<string> {
  let base: string;
  try {
    // Electron userData, or the platform data dir (DATA_DIR) in the server.
    base = appDataDir();
  } catch {
    base = path.join(os.homedir(), '.wayland');
  }
  const binDir = path.join(base, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  return binDir;
}

/**
 * Return the path to a `cloudflared` on PATH, or null if none is found.
 * Verified by running `cloudflared --version` and checking for exit code 0.
 */
export async function findCloudflaredOnPath(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, ['--version'], { stdio: 'ignore' });
    } catch {
      resolve(null);
      return;
    }
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code === 0 ? cmd : null));
  });
}

/** True when a regular file exists and is non-empty. */
async function isUsableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Download a URL to a destination file over https, following redirects (GitHub
 * release assets redirect to a CDN). Rejects on any non-2xx final response.
 */
async function downloadTo(url: string, dest: string, redirectsLeft = 5): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`[cloudflared] too many redirects fetching ${url}`));
          return;
        }
        downloadTo(res.headers.location, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`[cloudflared] download failed (HTTP ${status}) for ${url}`));
        return;
      }
      const out = createWriteStream(dest);
      pipeline(res, out).then(resolve, reject);
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error(`[cloudflared] download timed out for ${url}`));
    });
  });
}

/**
 * Extract the single `cloudflared` binary from a downloaded `.tgz` into the
 * bin dir, then remove the archive.
 */
async function extractTgz(archivePath: string, binDir: string, binName: string): Promise<void> {
  await tar.x({ file: archivePath, cwd: binDir });
  // The macOS tarball contains exactly `cloudflared`. Confirm it landed.
  const extracted = path.join(binDir, binName);
  if (!(await isUsableFile(extracted))) {
    throw new Error(`[cloudflared] archive did not contain expected binary ${binName}`);
  }
  await fs.rm(archivePath, { force: true });
}

/**
 * Resolve a usable cloudflared binary path, downloading it on first use.
 *
 * @throws when the current platform/arch has no published asset, or when the
 *   download fails / produces an unusable file. The message is actionable.
 */
export async function ensureCloudflaredBinary(): Promise<string> {
  const onPath = await findCloudflaredOnPath();
  if (onPath) return onPath;

  const spec = resolveAssetSpec(process.platform, process.arch);
  if (!spec) {
    throw new Error(
      `[cloudflared] no published cloudflared binary for ${process.platform}/${process.arch}. ` +
        'Install cloudflared manually and put it on PATH, then retry.'
    );
  }

  const binDir = await resolveBinDir();
  const binPath = path.join(binDir, spec.binName);

  // Reuse a previously downloaded binary if present.
  if (await isUsableFile(binPath)) {
    await ensureExecutable(binPath);
    return binPath;
  }

  const url = `${RELEASE_BASE}/${spec.asset}`;
  if (spec.archive) {
    const archivePath = path.join(binDir, spec.asset);
    await downloadTo(url, archivePath);
    if (!(await isUsableFile(archivePath))) {
      throw new Error(`[cloudflared] downloaded archive is empty: ${archivePath}`);
    }
    await extractTgz(archivePath, binDir, spec.binName);
  } else {
    await downloadTo(url, binPath);
  }

  if (!(await isUsableFile(binPath))) {
    throw new Error(`[cloudflared] downloaded binary is missing or empty: ${binPath}`);
  }
  await ensureExecutable(binPath);
  return binPath;
}

/** chmod +x on POSIX; no-op on Windows where the .exe extension is enough. */
async function ensureExecutable(binPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  await fs.chmod(binPath, 0o755);
}

/** Exported for tests: the per-platform asset resolver. */
export const __test = { resolveAssetSpec, RELEASE_BASE };
