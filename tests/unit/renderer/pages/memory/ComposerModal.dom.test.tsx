/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for ComposerModal.
 *
 * Covers: open/closed rendering, Escape/Cancel, the 40-character minimum and
 * 8000 limit, the six categories, the brain workspace picker (seeded from the
 * page's workspace filter, else `general`), the setQuickAdd payload, and the
 * backend's refusal message surfaced in a toast.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockSetQuickAdd, messageError, messageSuccess } = vi.hoisted(() => ({
  mockSetQuickAdd: vi.fn(),
  messageError: vi.fn(),
  messageSuccess: vi.fn(),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  memory: {
    setQuickAdd: { invoke: mockSetQuickAdd },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

// Arco stub - lightweight replacements; Modal surfaces onCancel for ESC testing.
vi.mock('@arco-design/web-react', () => {
  const ModalStub = ({
    visible,
    children,
    onCancel,
    'data-testid': testId,
    className,
  }: {
    visible: boolean;
    children?: React.ReactNode;
    onCancel?: () => void;
    'data-testid'?: string;
    className?: string;
    [key: string]: unknown;
  }) =>
    visible ? (
      <div
        role='dialog'
        data-testid={testId ?? 'modal-root'}
        className={className ?? ''}
        // Expose onCancel via data attr so tests can trigger it
        onKeyDown={(e) => {
          if (e.key === 'Escape' && onCancel) onCancel();
        }}
      >
        {children}
      </div>
    ) : null;

  const ButtonStub = ({
    children,
    onClick,
    disabled,
    loading,
    'data-testid': testId,
    type: _type,
    className: _className,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    'data-testid'?: string;
    type?: string;
    className?: string;
    [key: string]: unknown;
  }) => (
    <button type='button' onClick={onClick} disabled={disabled === true || loading === true} data-testid={testId}>
      {children}
    </button>
  );

  const InputTextAreaStub = ({
    value,
    onChange,
    onKeyDown,
    disabled,
    placeholder,
    'data-testid': testId,
  }: {
    value?: string;
    onChange?: (val: string) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    disabled?: boolean;
    placeholder?: string;
    'data-testid'?: string;
    [key: string]: unknown;
  }) => (
    <textarea
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      onKeyDown={onKeyDown}
      disabled={disabled}
      placeholder={placeholder}
      data-testid={testId}
    />
  );

  const InputStub = Object.assign(
    ({
      value,
      onChange,
      'data-testid': testId,
    }: {
      value?: string;
      onChange?: (v: string) => void;
      'data-testid'?: string;
    }) => <input value={value} onChange={(e) => onChange?.(e.target.value)} data-testid={testId} />,
    { TextArea: InputTextAreaStub }
  );

  const MessageStub = {
    success: messageSuccess,
    error: messageError,
  };

  return {
    Modal: ModalStub,
    Button: ButtonStub,
    Input: InputStub,
    Message: MessageStub,
  };
});

vi.mock('lucide-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lucide-react')>()),
  X: ({ size: _size, 'aria-hidden': _ah }: { size?: number; 'aria-hidden'?: boolean }) => <span data-icon='x' />,
}));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { ComposerModal } from '@renderer/pages/memory/components/ComposerModal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(props: Partial<React.ComponentProps<typeof ComposerModal>> = {}) {
  const onClose = (props.onClose ?? vi.fn()) as Mock;
  const utils = render(
    <ComposerModal
      open={props.open ?? true}
      onClose={onClose}
      workspaces={props.workspaces}
      defaultWorkspace={props.defaultWorkspace}
    />
  );
  return { onClose, ...utils };
}

const LONG = 'Deploy Memory from the brain MCP server so agents share one store.';

const type = (value: string): void => {
  fireEvent.change(screen.getByTestId('composer-textarea'), { target: { value } });
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mockSetQuickAdd.mockResolvedValue({ ok: true });
});

describe('ComposerModal', () => {
  it('renders when open and nothing when closed', () => {
    const { unmount } = setup();
    expect(screen.getByTestId('composer-modal')).toBeTruthy();
    unmount();
    setup({ open: false });
    expect(screen.queryByTestId('composer-modal')).toBeNull();
  });

  it('Escape and Cancel call onClose without saving', () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByTestId('composer-modal'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('composer-cancel-btn'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(mockSetQuickAdd).not.toHaveBeenCalled();
  });

  it('shows the 40-character minimum and keeps Remember disabled below it', () => {
    setup();
    expect(screen.getByTestId('composer-min-hint').textContent).toBe('At least {{min}} characters');
    type('too short to keep');
    expect((screen.getByTestId('composer-submit-btn') as HTMLButtonElement).disabled).toBe(true);
    type(LONG);
    expect((screen.getByTestId('composer-submit-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('rejects content over 8000 characters', () => {
    setup();
    type('x'.repeat(8001));
    expect((screen.getByTestId('composer-submit-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers the six categories with their meanings', () => {
    setup();
    for (const t of ['decision', 'preference', 'pattern', 'session', 'wiki', 'observation']) {
      expect(screen.getByTestId(`composer-category-${t}`)).toBeTruthy();
    }
    expect(screen.getByTestId('composer-category-observation').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('composer-category-pattern'));
    expect(screen.getByTestId('composer-category-pattern').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('composer-category-description').textContent).toBe(
      'Patterns, bug fixes, incidents, lessons and topology.'
    );
  });

  it('defaults to the general workspace and saves there as global', async () => {
    const { onClose } = setup({ workspaces: ['wayland', 'general'] });
    const picker = screen.getByTestId('composer-workspace-picker') as HTMLSelectElement;
    expect(picker.value).toBe('general');
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['general', 'wayland']);
    type(LONG);
    fireEvent.click(screen.getByTestId('composer-submit-btn'));
    await waitFor(() =>
      expect(mockSetQuickAdd).toHaveBeenCalledWith({
        content: LONG,
        scope: 'global',
        type: 'observation',
        projectPath: 'brain://general',
      })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(messageSuccess).toHaveBeenCalled();
  });

  it('seeds the workspace from the page filter and saves the chosen category there', async () => {
    setup({ workspaces: ['general', 'wayland'], defaultWorkspace: 'wayland' });
    expect((screen.getByTestId('composer-workspace-picker') as HTMLSelectElement).value).toBe('wayland');
    fireEvent.click(screen.getByTestId('composer-category-decision'));
    type(LONG);
    fireEvent.click(screen.getByTestId('composer-submit-btn'));
    await waitFor(() =>
      expect(mockSetQuickAdd).toHaveBeenCalledWith({
        content: LONG,
        scope: 'project',
        type: 'decision',
        projectPath: 'brain://wayland',
      })
    );
  });

  it('saves to a workspace picked by hand', async () => {
    setup({ workspaces: ['general', 'wayland', 'warrior'] });
    fireEvent.change(screen.getByTestId('composer-workspace-picker'), { target: { value: 'warrior' } });
    type(LONG);
    fireEvent.click(screen.getByTestId('composer-submit-btn'));
    await waitFor(() =>
      expect(mockSetQuickAdd).toHaveBeenCalledWith(expect.objectContaining({ projectPath: 'brain://warrior' }))
    );
  });

  it('Cmd+Enter submits', async () => {
    setup();
    type(LONG);
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('composer-textarea'), { key: 'Enter', metaKey: true });
    });
    await waitFor(() => expect(mockSetQuickAdd).toHaveBeenCalledTimes(1));
  });

  it('shows the backend error message in a toast and stays open', async () => {
    mockSetQuickAdd.mockResolvedValue({ ok: false, error: 'brain MCP server is not reachable' });
    const { onClose } = setup();
    type(LONG);
    fireEvent.click(screen.getByTestId('composer-submit-btn'));
    await waitFor(() => expect(messageError).toHaveBeenCalledWith('brain MCP server is not reachable'));
    expect(screen.getByTestId('composer-error').textContent).toBe('brain MCP server is not reachable');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a thrown error message in a toast', async () => {
    mockSetQuickAdd.mockRejectedValue(new Error('A brain memory needs at least 40 characters of substance'));
    setup();
    type(LONG);
    fireEvent.click(screen.getByTestId('composer-submit-btn'));
    await waitFor(() =>
      expect(messageError).toHaveBeenCalledWith('A brain memory needs at least 40 characters of substance')
    );
  });
});
