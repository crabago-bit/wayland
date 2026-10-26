import { describe, expect, it } from 'vitest';
import { isAllowedForRemote, isRemoteDeniedProviderKey, isSshFsCall } from '../../src/common/adapter/bridgeAllowlist';

const call = (key: string, data: unknown) => isAllowedForRemote(`subscribe-${key}`, { id: 'x', data });

describe('ssh:// file calls from a paired browser', () => {
  it('allows file calls whose every path is an ssh:// path', () => {
    expect(call('read-file', { path: 'ssh://vps/home/forge/a.txt' })).toBe(true);
    expect(call('read-file-buffer', { path: 'ssh://gw/srv/x.png' })).toBe(true);
    expect(call('write-file', { path: 'ssh://vps/home/forge/a.txt', data: 'hi' })).toBe(true);
    expect(call('get-file-metadata', { path: 'ssh://vps/home/forge/a.txt' })).toBe(true);
    expect(call('get-image-base64', { path: 'ssh://vps/home/forge/a.png' })).toBe(true);
    expect(call('get-file-by-dir', { dir: 'ssh://vps/srv', root: 'ssh://vps/srv' })).toBe(true);
    expect(call('list-workspace-files', { root: 'ssh://vps/srv' })).toBe(true);
  });

  it('keeps every local path denied, with or without a payload', () => {
    for (const key of ['read-file', 'write-file', 'get-file-by-dir', 'list-workspace-files', 'get-image-base64']) {
      expect(isRemoteDeniedProviderKey(key)).toBe(true);
      expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
    }
    expect(call('read-file', { path: '/etc/passwd' })).toBe(false);
    expect(call('write-file', { path: '/home/forge/.bashrc', data: 'x' })).toBe(false);
    expect(call('read-file', { path: '../../etc/passwd' })).toBe(false);
    expect(call('read-file', {})).toBe(false);
    expect(call('read-file', undefined)).toBe(false);
  });

  it('denies a call that mixes a remote path with a local one', () => {
    expect(call('get-file-by-dir', { dir: 'ssh://vps/srv', root: '/home/forge' })).toBe(false);
    expect(call('get-file-by-dir', { dir: '/home/forge', root: 'ssh://vps/srv' })).toBe(false);
    expect(call('get-file-by-dir', { dir: 'ssh://vps/srv' })).toBe(false);
  });

  it('does not exempt destructive or unlisted file keys even with an ssh:// path', () => {
    for (const key of ['remove-entry', 'rename-entry', 'move-entry', 'create-temp-file', 'copy-files-to-workspace']) {
      expect(call(key, { path: 'ssh://vps/srv/a' })).toBe(false);
    }
  });

  it('rejects look-alike schemes and malformed hosts', () => {
    expect(isSshFsCall('read-file', { path: 'ssh:/vps/a' })).toBe(false);
    expect(isSshFsCall('read-file', { path: 'SSH://vps/a' })).toBe(false);
    expect(isSshFsCall('read-file', { path: 'ssh://-oProxyCommand=x/a' })).toBe(false);
    expect(isSshFsCall('read-file', { path: 'ssh://a b/a' })).toBe(false);
    expect(isSshFsCall('read-file', { path: ['ssh://vps/a'] })).toBe(false);
    expect(isSshFsCall('read-file', { path: 'file:///etc/passwd' })).toBe(false);
  });
});
