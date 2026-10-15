import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyStagedFuigo } from '../../../scripts/fuigo/verify-staged.cjs';

const RUNTIME = 'linux-x64';
let dir: string;

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function stage(versionLine: string, exitCode = 0): string {
  const file = path.join(dir, 'fuigo');
  fs.writeFileSync(file, `#!/bin/sh\necho '${versionLine}'\nexit ${exitCode}\n`, { mode: 0o755 });
  return sha(file);
}

function receipt(overrides: Record<string, unknown> = {}): void {
  const digest = sha(path.join(dir, 'fuigo'));
  fs.writeFileSync(
    path.join(dir, 'bundle.json'),
    JSON.stringify({
      version: '1.0.19',
      runtime: RUNTIME,
      binarySha256: digest,
      stagedSha256: digest,
      binary: 'fuigo',
      ...overrides,
    })
  );
}

const authority = (binarySha256: string, version = '1.0.19') => ({
  version,
  platforms: { [RUNTIME]: { binarySha256 } },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-staged-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('verifyStagedFuigo', () => {
  it('passes when the binary matches the receipt, the pin and reports the pinned version', () => {
    const digest = stage('fuigo 1.0.19 (b156799be642)');
    receipt();
    expect(verifyStagedFuigo(dir, RUNTIME, authority(digest))).toEqual({
      version: '1.0.19',
      runtime: RUNTIME,
      sha256: digest,
    });
  });

  it('fails when the staged binary and receipt agree but differ from the pin', () => {
    stage('fuigo 1.0.19 (x)');
    // Receipt rewritten to match a swapped binary: only the direct pin compare catches it.
    receipt({ binarySha256: 'a'.repeat(64) });
    expect(() => verifyStagedFuigo(dir, RUNTIME, authority('a'.repeat(64)))).toThrow(/!= pin linux-x64 binarySha256/);
  });

  it('fails when the binary differs from the receipt', () => {
    const digest = stage('fuigo 1.0.19 (x)');
    receipt({ stagedSha256: 'b'.repeat(64) });
    expect(() => verifyStagedFuigo(dir, RUNTIME, authority(digest))).toThrow(/!= bundle.json/);
  });

  it('fails when the receipt names another version', () => {
    const digest = stage('fuigo 1.0.19 (x)');
    receipt({ version: '1.0.18' });
    expect(() => verifyStagedFuigo(dir, RUNTIME, authority(digest))).toThrow(/does not match the pin/);
  });

  it('fails when fuigo --version reports another version', () => {
    const digest = stage('fuigo 1.0.18 (x)');
    receipt();
    expect(() => verifyStagedFuigo(dir, RUNTIME, authority(digest))).toThrow(/--version reports/);
  });

  it('fails when fuigo --version exits non-zero', () => {
    const digest = stage('fuigo 1.0.19 (x)', 3);
    receipt();
    expect(() => verifyStagedFuigo(dir, RUNTIME, authority(digest))).toThrow(/exited 3/);
  });

  it('fails when the receipt runtime is not the expected runtime', () => {
    const digest = stage('fuigo 1.0.19 (x)');
    receipt({ runtime: 'linux-arm64' });
    expect(() => verifyStagedFuigo(dir, RUNTIME, authority(digest))).toThrow(/runtime linux-arm64/);
  });

  it('refuses a symlinked binary', () => {
    const digest = stage('fuigo 1.0.19 (x)');
    fs.renameSync(path.join(dir, 'fuigo'), path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'fuigo'));
    receipt({ binarySha256: digest, stagedSha256: digest });
    expect(() => verifyStagedFuigo(dir, RUNTIME, authority(digest))).toThrow(/symlink/);
  });
});
