import { describe, expect, it } from 'vitest';
import { findSshHost, parseSshConfig } from '../../src/process/services/sshHosts/sshConfig';
import {
  buildRemoteListCommand,
  parseRemoteListing,
  shellQuote,
  sshArgs,
} from '../../src/process/services/sshHosts/sshRemoteBrowse';

const CONFIG = `
# comment
Host github-cc
  HostName github.com
  User git
Host vps
  HostName 203.0.113.5
  User forge
  Port 2222
Host mac
  HostName 127.0.0.1
  User cory
Host gw-build-1 oce-box gw
  HostName 198.51.100.7
  User forge
Host *
  ServerAliveInterval 30
Host bad-*  !negated -evil "two words" ok.host
  HostName 192.0.2.1
Match host foo
  User ignored
`;

describe('parseSshConfig', () => {
  const hosts = parseSshConfig(CONFIG);

  it('keeps concrete hosts and drops git forges, wildcards and unsafe aliases', () => {
    expect(hosts.map((h) => h.alias)).toEqual(['vps', 'mac', 'gw-build-1', 'ok.host']);
  });

  it('groups every alias on one Host line', () => {
    expect(hosts[2].aliases).toEqual(['gw-build-1', 'oce-box', 'gw']);
    expect(findSshHost('oce-box', hosts)?.alias).toBe('gw-build-1');
  });

  it('reads hostname, user and port', () => {
    expect(hosts[0]).toMatchObject({ hostName: '203.0.113.5', user: 'forge', port: 2222 });
  });

  it('does not look up names that are not configured', () => {
    expect(findSshHost('-oProxyCommand=evil', hosts)).toBeUndefined();
    expect(findSshHost('github-cc', hosts)).toBeUndefined();
  });

  it('tolerates empty or missing config', () => {
    expect(parseSshConfig('')).toEqual([]);
  });
});

describe('remote listing', () => {
  it('quotes hostile paths as a single shell word', () => {
    expect(shellQuote("a'b; rm -rf /")).toBe(`'a'\\''b; rm -rf /'`);
    expect(buildRemoteListCommand("x'; touch /tmp/pwn; '")).toContain(`'x'\\''; touch /tmp/pwn; '\\'''`);
  });

  it('ends ssh options before the host and never allocates a tty', () => {
    const args = sshArgs({ alias: 'gw', aliases: ['gw'] }, 'cmd');
    expect(args.slice(0, 1)).toEqual(['-T']);
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('gw'));
    expect(args).toContain('BatchMode=yes');
  });

  it('parses NUL-delimited output, hides dotfiles, sorts folders first', () => {
    const out = ['/srv/app', 'f', 'b.txt', 'd', 'zeta', 'd', 'alpha', 'd', '.git', 'f', 'a.txt', ''].join('\0');
    const dirsOnly = parseRemoteListing(out, false);
    expect(dirsOnly.items.map((i) => i.name)).toEqual(['alpha', 'zeta']);
    expect(dirsOnly.items[0].path).toBe('/srv/app/alpha');
    expect(dirsOnly.parentPath).toBe('/srv');
    const all = parseRemoteListing(out, true);
    expect(all.items.map((i) => i.name)).toEqual(['alpha', 'zeta', 'a.txt', 'b.txt']);
  });

  it('handles root and rejects garbage', () => {
    expect(parseRemoteListing('/\0d\0etc\0', false)).toMatchObject({ canGoUp: false, items: [{ path: '/etc' }] });
    expect(() => parseRemoteListing('not a path\0', false)).toThrow();
  });
});
