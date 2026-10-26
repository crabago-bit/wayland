import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
}));

import DirectorySelectionModal from '../../src/renderer/components/settings/DirectorySelectionModal';

const listing = { currentPath: '/srv', parentPath: '/', canGoUp: true, items: [{ name: 'app', path: '/srv/app', isDirectory: true, isFile: false }] };

describe('DirectorySelectionModal', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('ssh-hosts') ? { hosts: [{ alias: 'gw', user: 'forge', hostName: '1.2.3.4' }] } : listing),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('renders closed without fetching or crashing', () => {
    render(<DirectorySelectionModal visible={false} onConfirm={() => {}} onCancel={() => {}} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('local mode never asks for SSH hosts', async () => {
    render(<DirectorySelectionModal visible onConfirm={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('ssh-hosts'))).toBe(false);
    expect(await screen.findByText('app')).toBeTruthy();
  });

  it('allowRemote loads the host list and shows the picker', async () => {
    await act(async () => {
      render(<DirectorySelectionModal visible allowRemote onConfirm={() => {}} onCancel={() => {}} />);
    });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('ssh-hosts'))).toBe(true));
    expect(await screen.findByText('app')).toBeTruthy();
  });
});
