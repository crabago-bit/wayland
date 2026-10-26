/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for EntryEditorModal. Editing one field sends ONLY that field to
 * memory.update-entry; the brain's 40-character minimum is enforced; and a
 * backend refusal is shown verbatim in a toast.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryEntry } from '@/common/types/memory';

const { updateEntry, messageError } = vi.hoisted(() => ({ updateEntry: vi.fn(), messageError: vi.fn() }));

vi.mock('@/common/adapter/ipcBridge', () => ({
  memory: { updateEntry: { invoke: updateEntry } },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: unknown) => (typeof fb === 'string' ? fb : _k) }),
}));

// Minimal Arco stubs: expose the OK button (with its disabled state) and the
// summary input; other fields are inert passthroughs for this diff test.
vi.mock('@arco-design/web-react', () => {
  const Input: React.FC<Record<string, unknown>> & { TextArea: React.FC<Record<string, unknown>> } = ((
    props: Record<string, unknown>
  ) => (
    <input
      data-testid={props['data-testid'] as string}
      value={props.value as string}
      onChange={(e) => (props.onChange as (v: string) => void)?.(e.target.value)}
    />
  )) as never;
  Input.TextArea = (props: Record<string, unknown>) => (
    <textarea
      data-testid={props['data-testid'] as string}
      value={props.value as string}
      onChange={(e) => (props.onChange as (v: string) => void)?.(e.target.value)}
    />
  );
  return {
    Input,
    Select: Object.assign(
      (props: Record<string, unknown>) => (
        <div data-testid={props['data-testid'] as string}>{props.children as React.ReactNode}</div>
      ),
      {
        Option: (props: Record<string, unknown>) => (
          <span data-testid={`editor-option-${props.value as string}`}>{props.children as React.ReactNode}</span>
        ),
      }
    ),
    Message: { success: vi.fn(), error: messageError },
    Modal: (props: Record<string, unknown>) => {
      if (!props.visible) return null;
      const okp = (props.okButtonProps as { disabled?: boolean }) ?? {};
      return (
        <div>
          {props.children as React.ReactNode}
          <button data-testid='modal-ok' disabled={okp.disabled} onClick={props.onOk as () => void}>
            ok
          </button>
        </div>
      );
    },
  };
});

// eslint-disable-next-line import/first
import EntryEditorModal from '@/renderer/pages/memory/components/EntryEditorModal';

const ENTRY: MemoryEntry & { body: string } = {
  id: 'entry-001',
  type: 'decision',
  project: 'wayland',
  projectPath: 'brain://wayland',
  summary: 'Original summary',
  bodyPreview: 'prev',
  body: 'Original body that is long enough for the brain to keep.',
  tags: ['decision', 'paste'],
  storedAt: 1,
  sourcePath: 'brain://wayland/entry-001',
  sourceLine: 0,
  referencedBy: 0,
  promotionScore: 0,
};

afterEach(() => {
  cleanup();
  updateEntry.mockReset();
  messageError.mockReset();
});

beforeEach(() => {
  updateEntry.mockResolvedValue({ ok: true, newId: 'entry-new' });
});

const NEW_BODY = 'A brand new body that is comfortably over forty characters.';

describe('EntryEditorModal', () => {
  it('prefills the summary from the entry', () => {
    render(<EntryEditorModal open entry={ENTRY} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect((screen.getByTestId('entry-editor-summary') as HTMLInputElement).value).toBe('Original summary');
  });

  it('disables Save when nothing has changed', () => {
    render(<EntryEditorModal open entry={ENTRY} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect((screen.getByTestId('modal-ok') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends ONLY the changed field (summary) and calls onSaved with the new id', async () => {
    const onSaved = vi.fn();
    render(<EntryEditorModal open entry={ENTRY} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('entry-editor-summary'), { target: { value: 'Renamed' } });
    expect((screen.getByTestId('modal-ok') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('modal-ok'));
    await waitFor(() => expect(updateEntry).toHaveBeenCalledTimes(1));
    // Diff-only: no type/tags/body in the payload.
    expect(updateEntry).toHaveBeenCalledWith({ id: 'entry-001', summary: 'Renamed' });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('entry-new'));
  });

  it('does not save when the summary is cleared (empty summary is invalid)', () => {
    render(<EntryEditorModal open entry={ENTRY} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('entry-editor-summary'), { target: { value: '   ' } });
    expect((screen.getByTestId('modal-ok') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends only the body when only the body changed', async () => {
    render(<EntryEditorModal open entry={ENTRY} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('entry-editor-body'), { target: { value: NEW_BODY } });
    fireEvent.click(screen.getByTestId('modal-ok'));
    await waitFor(() => expect(updateEntry).toHaveBeenCalledWith({ id: 'entry-001', body: NEW_BODY }));
  });

  it('blocks saving a body under 40 characters and shows the minimum', () => {
    render(<EntryEditorModal open entry={ENTRY} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('entry-editor-min-hint').textContent).toBe('At least {{min}} characters');
    fireEvent.change(screen.getByTestId('entry-editor-body'), { target: { value: 'too short' } });
    expect((screen.getByTestId('modal-ok') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers all six categories with their meanings', () => {
    render(<EntryEditorModal open entry={ENTRY} onClose={vi.fn()} onSaved={vi.fn()} />);
    for (const type of ['decision', 'preference', 'pattern', 'session', 'wiki', 'observation']) {
      expect(screen.getByTestId(`editor-option-${type}`)).toBeTruthy();
    }
    expect(screen.getByTestId('editor-option-wiki').textContent).toBe(
      'Wiki - Notes from Obsidian, files, URLs and docs.'
    );
  });

  it('names the workspace the memory is saved in', () => {
    render(<EntryEditorModal open entry={ENTRY} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('entry-editor-workspace')).toBeTruthy();
  });

  it('shows the backend error message in a toast when the save is refused', async () => {
    updateEntry.mockResolvedValue({ ok: false, error: 'That memory is no longer in the brain index' });
    const onSaved = vi.fn();
    render(<EntryEditorModal open entry={ENTRY} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('entry-editor-summary'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('modal-ok'));
    await waitFor(() => expect(messageError).toHaveBeenCalledWith('That memory is no longer in the brain index'));
    expect(onSaved).not.toHaveBeenCalled();
  });
});
