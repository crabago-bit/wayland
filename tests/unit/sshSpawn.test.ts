import { describe, expect, it } from 'vitest';
import { buildSshSpawn, remoteAgentArgv } from '../../src/process/services/sshHosts/sshSpawn';

const host = { alias: 'gw', aliases: ['gw'] };

describe('remoteAgentArgv', () => {
  it('runs claude and codex through their pinned bridge packages and ignores local flags', () => {
    expect(remoteAgentArgv('claude', '/usr/bin/claude', ['--local'])?.slice(0, 2)).toEqual(['npx', '-y']);
    expect(remoteAgentArgv('codex')?.[2]).toMatch(/^@agentclientprotocol\/codex-acp@/);
    expect(remoteAgentArgv('claude')).toHaveLength(3);
  });

  it('accepts a bare command but refuses local absolute paths and odd names', () => {
    expect(remoteAgentArgv('goose', 'goose', ['acp'])).toEqual(['goose', 'acp']);
    expect(remoteAgentArgv('fuigo', '/home/forge/.local/fuigo')).toBeUndefined();
    expect(remoteAgentArgv('x', 'a b')).toBeUndefined();
    expect(remoteAgentArgv('x', '../evil')).toBeUndefined();
    expect(remoteAgentArgv('x')).toBeUndefined();
  });
});

describe('buildSshSpawn', () => {
  it('puts the host after `--`, disables prompts, and forwards no tty', () => {
    const s = buildSshSpawn(host, '/srv/app', ['npx', '-y', 'pkg@1']);
    expect(s.command).toBe('ssh');
    expect(s.args[0]).toBe('-T');
    expect(s.args).toContain('BatchMode=yes');
    expect(s.args.indexOf('--')).toBe(s.args.length - 3);
    expect(s.args[s.args.length - 2]).toBe('gw');
  });

  it('quotes cwd and every argv word so nothing can add a command', () => {
    const s = buildSshSpawn(host, "/srv/it's; touch /tmp/pwn", ['run', "a'b", '$(id)']);
    const remote = s.args[s.args.length - 1];
    expect(remote.startsWith("bash -lc '")).toBe(true);
    expect(remote).toContain("cd '\\''/srv/it");
    expect(remote).not.toMatch(/[^\\']\$\(id\)[^']/);
  });

  it('sources the host-side agent env file instead of carrying secrets in the command', () => {
    const remote = buildSshSpawn(host, '/srv/app', ['x']).args.slice(-1)[0];
    expect(remote).toContain('.wayland-agent.env');
    expect(remote).toContain('set -a');
    expect(remote.indexOf('. ')).toBeLessThan(remote.indexOf('exec'));
  });

  it('rejects relative or NUL-bearing paths and empty commands', () => {
    expect(() => buildSshSpawn(host, 'relative', ['x'])).toThrow();
    expect(() => buildSshSpawn(host, '/a\0b', ['x'])).toThrow();
    expect(() => buildSshSpawn(host, '/a', [])).toThrow();
  });

  it('forwards only the environment ssh itself needs', () => {
    process.env.OPENAI_API_KEY = 'sk-secret';
    const s = buildSshSpawn(host, '/a', ['x']);
    expect(s.env.OPENAI_API_KEY).toBeUndefined();
    expect(
      Object.keys(s.env).every((k) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'LANG'].includes(k))
    ).toBe(true);
  });
});
