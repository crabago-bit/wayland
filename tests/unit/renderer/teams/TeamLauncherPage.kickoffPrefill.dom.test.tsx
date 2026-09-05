/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * A team launcher's first kickoff carries a `prefill` - the ordered pipeline
 * its author wrote for the leader's first turn. Assistant packs render their
 * `tasks` into exactly this field (`buildPackTeam`), and the built-in launchers
 * author it by hand.
 *
 * Nothing read it. `TeamLauncherPage` hydrated `goalText: ''` unconditionally
 * and only rendered the goal box in build-my-own mode, so a pre-configured team
 * launched onto an empty "Describe your goal" screen and the whole authored
 * pipeline was inert. These tests pin the three halves of the fix: the prefill
 * is hydrated, it is shown and editable, and it is what gets sent on launch.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const PREFILL = [
  'Assemble the Desk team and run the following pipeline in order.',
  'Leader: pack-warrior-editor.',
  '',
  '1. Survey [owner: pack-warrior-scout]',
  '2. Cut [owner: pack-warrior-editor] [blocked by: Survey]',
].join('\n');

const mockAssistants = vi.hoisted(() => {
  const prefill = [
    'Assemble the Desk team and run the following pipeline in order.',
    'Leader: pack-warrior-editor.',
    '',
    '1. Survey [owner: pack-warrior-scout]',
    '2. Cut [owner: pack-warrior-editor] [blocked by: Survey]',
  ].join('\n');
  // A pack-authored team launcher, exactly as `buildPackTeam` writes it.
  const packTeam = {
    id: 'pack-warrior-desk',
    name: 'Desk',
    nameI18n: { 'en-US': 'Desk' },
    descriptionI18n: { 'en-US': 'Pack team.' },
    isBuiltin: false,
    isPreset: true,
    presetAgentType: 'claude',
    _source: 'builtin',
    _kind: 'team',
    _teammates: ['pack-warrior-editor', 'pack-warrior-scout'],
    _kickoffs: [
      { id: 'pack-warrior-desk-pipeline', text: 'Run the Desk pipeline (2 tasks).', prefill, scenario: 'cold-start' },
    ],
  };
  // A launcher with NO kickoffs: the goal box must stay hidden for it.
  const bareTeam = {
    id: 'ext-bare-team',
    name: 'Bare',
    nameI18n: { 'en-US': 'Bare' },
    descriptionI18n: { 'en-US': 'No kickoff authored.' },
    isBuiltin: false,
    isPreset: true,
    presetAgentType: 'claude',
    _source: 'extension',
    _kind: 'team',
    _teammates: ['pack-warrior-scout'],
  };
  const specialists = [
    { id: 'pack-warrior-editor', name: 'Editor' },
    { id: 'pack-warrior-scout', name: 'Scout' },
  ].map((s) => ({
    id: s.id,
    name: s.name,
    nameI18n: { 'en-US': s.name },
    descriptionI18n: { 'en-US': `${s.name} description` },
    isBuiltin: false,
    isPreset: true,
    presetAgentType: 'claude',
    _source: 'builtin',
    _kind: 'specialist',
  }));
  return [packTeam, bareTeam, ...specialists];
});

const navigateMock = vi.hoisted(() => vi.fn());
const teamCreateInvokeMock = vi.hoisted(() => vi.fn());
const teamSendMessageInvokeMock = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number; name?: string }) => {
      let v = opts?.defaultValue ?? key;
      if (opts?.count !== undefined) v = v.replace('{{count}}', String(opts.count));
      if (opts?.name !== undefined) v = v.replace('{{name}}', String(opts.name));
      return v;
    },
  }),
}));

// Arco's Message helpers call legacy ReactDOM.render, removed in React 19.
const messageMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: messageMock };
});

vi.mock('@/renderer/utils/platform', () => ({
  resolveExtensionAssetUrl: (v: string) => v,
}));

vi.mock('@/renderer/hooks/assistant', () => ({
  useAssistantList: () => ({
    assistants: mockAssistants,
    activeAssistantId: null,
    setActiveAssistantId: vi.fn(),
    activeAssistant: null,
    isExtensionAssistant: () => true,
    loadAssistants: vi.fn().mockResolvedValue(undefined),
    localeKey: 'en-US',
  }),
}));

// Hoisted for a stable identity across renders - a fresh literal would
// invalidate the page's useMemo deps and spin forever.
const availableBackendsMock = vi.hoisted(() => ({
  available: ['gemini', 'claude', 'wayland-core'],
  recommend: (presetAgentType?: string) =>
    presetAgentType && ['gemini', 'claude', 'wayland-core'].includes(presetAgentType)
      ? presetAgentType
      : 'wayland-core',
}));
vi.mock('@/renderer/hooks/assistant/useAvailableBackends', () => ({
  useAvailableBackends: () => availableBackendsMock,
}));

vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'test-user-1' } }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    team: {
      create: { invoke: teamCreateInvokeMock },
      sendMessage: { invoke: teamSendMessageInvokeMock },
    },
  },
}));

vi.mock('@/renderer/pages/guid/constants', () => ({
  CUSTOM_AVATAR_IMAGE_MAP: {} as Record<string, string>,
}));

vi.mock('@renderer/components/base/WaylandModal', () => ({
  default: ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? <div data-testid='teams-launcher-modal-shell'>{children}</div> : null,
}));

import TeamLauncherPage, { launcherGoalPrefill } from '../../../../src/renderer/pages/teams/TeamLauncherPage';

const renderLauncher = (teamId: string) =>
  render(
    <MemoryRouter initialEntries={[`/teams/${teamId}/launch`]}>
      <Routes>
        <Route path='/teams/:teamId/launch' element={<TeamLauncherPage />} />
      </Routes>
    </MemoryRouter>
  );

describe('launcherGoalPrefill', () => {
  it('reads the first kickoff prefill', () => {
    expect(
      launcherGoalPrefill({ _kickoffs: [{ id: 'k', text: 't', prefill: ' body ', scenario: 'cold-start' }] })
    ).toBe('body');
  });

  it('returns empty for a launcher with no kickoffs, an empty list, or no launcher at all', () => {
    expect(launcherGoalPrefill({ _kickoffs: undefined })).toBe('');
    expect(launcherGoalPrefill({ _kickoffs: [] })).toBe('');
    expect(launcherGoalPrefill(null)).toBe('');
    expect(launcherGoalPrefill(undefined)).toBe('');
  });

  it('ignores a kickoff whose prefill is only whitespace', () => {
    expect(launcherGoalPrefill({ _kickoffs: [{ id: 'k', text: 't', prefill: '   ', scenario: 'cold-start' }] })).toBe(
      ''
    );
  });
});

describe('TeamLauncherPage kickoff prefill', () => {
  it('shows the authored pipeline in the goal box, prefilled and editable', async () => {
    renderLauncher('pack-warrior-desk');
    await waitFor(() => screen.getByTestId('launcher-roster-card'));

    const input = (await waitFor(() => screen.getByTestId('launcher-goal-input'))) as HTMLTextAreaElement;
    expect(input.value).toBe(PREFILL);
    // Editable: the box is a plain textarea seeded with the prefill, not a
    // read-only rendering of it.
    fireEvent.change(input, { target: { value: 'My own brief' } });
    await waitFor(() =>
      expect((screen.getByTestId('launcher-goal-input') as HTMLTextAreaElement).value).toBe('My own brief')
    );
  });

  it('does not offer roster Suggest on a pre-configured launcher', async () => {
    renderLauncher('pack-warrior-desk');
    await waitFor(() => screen.getByTestId('launcher-goal-input'));
    expect(screen.queryByTestId('launcher-suggest-btn')).toBeNull();
  });

  it('keeps the goal box hidden for a launcher that authored no kickoff', async () => {
    renderLauncher('ext-bare-team');
    await waitFor(() => screen.getByTestId('launcher-roster-card'));
    expect(screen.queryByTestId('launcher-goal-card')).toBeNull();
  });

  it('sends the prefill as the kickoff message on launch', async () => {
    teamCreateInvokeMock.mockResolvedValue({ id: 'team-1', name: 'Desk' });
    teamSendMessageInvokeMock.mockResolvedValue(undefined);

    renderLauncher('pack-warrior-desk');
    await waitFor(() => screen.getByTestId('launcher-goal-input'));
    fireEvent.click(screen.getByTestId('launcher-launch-cta'));

    await waitFor(() => expect(teamSendMessageInvokeMock).toHaveBeenCalled());
    expect(teamSendMessageInvokeMock).toHaveBeenCalledWith({ teamId: 'team-1', content: PREFILL });
  });

  it('sends the user edit rather than the prefill when the brief was changed', async () => {
    teamCreateInvokeMock.mockResolvedValue({ id: 'team-2', name: 'Desk' });
    teamSendMessageInvokeMock.mockResolvedValue(undefined);
    teamSendMessageInvokeMock.mockClear();

    renderLauncher('pack-warrior-desk');
    const input = (await waitFor(() => screen.getByTestId('launcher-goal-input'))) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Skip step 1, start at Cut.' } });
    fireEvent.click(screen.getByTestId('launcher-launch-cta'));

    await waitFor(() => expect(teamSendMessageInvokeMock).toHaveBeenCalled());
    expect(teamSendMessageInvokeMock).toHaveBeenCalledWith({ teamId: 'team-2', content: 'Skip step 1, start at Cut.' });
  });
});
