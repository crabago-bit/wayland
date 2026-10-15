import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../scripts/warriorhi-fuigo-default-model.mjs');

const encode = (data: unknown) => Buffer.from(encodeURIComponent(JSON.stringify(data)), 'latin1').toString('base64');
const decode = (text: string) =>
  JSON.parse(decodeURIComponent(Buffer.from(text.trim(), 'base64').toString('latin1'))) as Record<string, unknown>;

const ROW = {
  id: 'jarvis-row',
  name: 'JARVIS',
  enabled: true,
  baseUrl: 'http://127.0.0.1:4000/v1',
  model: ['jarvis-default'],
};

let root: string;
let dataDir: string;
let binDir: string;
let configFile: string;

/** A port nothing listens on: bind an ephemeral port, then release it. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function fakePm2(status: string | null): void {
  const list = status ? [{ name: 'wayland-webui', pm2_env: { status } }] : [];
  fs.writeFileSync(path.join(binDir, 'pm2'), `#!/bin/sh\necho '${JSON.stringify(list)}'\n`, { mode: 0o755 });
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--data-dir', dataDir, ...args], {
      env: { ...process.env, PATH: binDir, ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fuigo-default-model-'));
  dataDir = path.join(root, 'data');
  binDir = path.join(root, 'bin');
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  fs.mkdirSync(binDir);
  configFile = path.join(dataDir, 'config', 'wayland-config.txt');
  fs.writeFileSync(configFile, encode({ 'model.config': [ROW] }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('warriorhi-fuigo-default-model --server-stopped', () => {
  it('writes when pm2 is missing and nothing listens on the port', async () => {
    const port = await freePort();
    const res = await run(['--server-stopped', '--port', String(port)]);
    expect(res.out).toContain('written');
    expect(res.code).toBe(0);
    expect(decode(fs.readFileSync(configFile, 'utf8'))['fuigo.defaultModel']).toEqual({
      id: 'jarvis-row',
      useModel: 'jarvis-default',
    });
  });

  it('writes when pm2 reports the app stopped', async () => {
    fakePm2('stopped');
    const res = await run(['--server-stopped', '--port', String(await freePort())]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('written');
  });

  it('refuses to write while pm2 reports wayland-webui online', async () => {
    fakePm2('online');
    const before = fs.readFileSync(configFile, 'utf8');
    const res = await run(['--server-stopped', '--port', String(await freePort())]);
    expect(res.code).toBe(1);
    expect(res.out).toContain('pm2 reports wayland-webui online');
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
  });

  it('refuses to write while something listens on the WebUI port', async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const before = fs.readFileSync(configFile, 'utf8');
      const res = await run(['--server-stopped', '--port', String(port)]);
      expect(res.code).toBe(1);
      expect(res.out).toContain(`listening on 127.0.0.1:${port}`);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps --dry-run working while the server runs', async () => {
    fakePm2('online');
    const before = fs.readFileSync(configFile, 'utf8');
    const res = await run(['--dry-run']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('fuigo.defaultModel: null');
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
  });

  it('still requires --server-stopped to write', async () => {
    const res = await run(['--port', String(await freePort())]);
    expect(res.code).toBe(1);
    expect(res.out).toContain('pass --server-stopped');
  });
});
