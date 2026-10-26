import { describe, expect, it } from 'vitest';
import { buildRemoteTree, isRemotePath, type RemoteEntry } from '../../src/process/services/sshHosts/sshRemoteFs';

const host = { alias: 'gw', aliases: ['gw'] };
const entry = (relativePath: string, isDir: boolean): RemoteEntry => ({
  name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
  fullPath: `ssh://gw/srv/app/${relativePath}`,
  relativePath,
  isDir,
  isFile: !isDir,
});

describe('isRemotePath', () => {
  it('recognises ssh workspace strings only', () => {
    expect(isRemotePath('ssh://gw/srv/app')).toBe(true);
    expect(isRemotePath('/srv/app')).toBe(false);
    expect(isRemotePath('ssh:/gw/x')).toBe(false);
    expect(isRemotePath(undefined)).toBe(false);
  });
});

describe('buildRemoteTree', () => {
  const ref = { host, path: '/srv/app' };
  const tree = buildRemoteTree(ref, [
    entry('b.txt', false),
    entry('src', true),
    entry('src/z.ts', false),
    entry('src/a', true),
    entry('src/a/deep.ts', false),
    entry('a.txt', false),
  ]);

  it('roots the tree at the workspace with a remote full path', () => {
    expect(tree).toMatchObject({ name: 'app', fullPath: 'ssh://gw/srv/app', relativePath: '', isDir: true });
  });

  it('nests children under their directories, folders first then by name', () => {
    expect(tree.children?.map((c) => c.name)).toEqual(['src', 'a.txt', 'b.txt']);
    const src = tree.children?.[0];
    expect(src?.children?.map((c) => c.name)).toEqual(['a', 'z.ts']);
    expect(src?.children?.[0].children?.[0].fullPath).toBe('ssh://gw/srv/app/src/a/deep.ts');
  });

  it('gives files no children array', () => {
    expect(tree.children?.[1].children).toBeUndefined();
  });
});
