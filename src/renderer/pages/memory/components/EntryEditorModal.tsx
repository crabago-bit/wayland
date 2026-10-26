/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EntryEditorModal - edit a single brain memory.
 *
 * Prefilled from the selected entry (summary/category/body). The brain is
 * append-only, so saving writes a new version in the same workspace and
 * supersedes the old one; the caller receives the new id via onSaved to
 * re-select the row. Only CHANGED fields are sent to `memory.update-entry`.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Input, Message, Modal, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { memory as memoryBridge } from '@/common/adapter/ipcBridge';
import type { MemoryEntry, MemoryType } from '@/common/types/memory';
import { MEMORY_CATEGORIES, MIN_MEMORY_CHARS } from '../categories';

export type EntryEditorTarget = MemoryEntry & { body: string };

export type EntryEditorModalProps = {
  open: boolean;
  entry: EntryEditorTarget | null;
  onClose: () => void;
  /** Called after a successful save with the entry's (possibly new) id. */
  onSaved: (newId: string) => void;
};

const EntryEditorModal: React.FC<EntryEditorModalProps> = ({ open, entry, onClose, onSaved }) => {
  const { t } = useTranslation('memory');

  const [summary, setSummary] = useState('');
  const [type, setType] = useState<MemoryType>('observation');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset the form whenever a new entry is opened.
  useEffect(() => {
    if (entry) {
      setSummary(entry.summary);
      setType(entry.type);
      setBody(entry.body ?? '');
    }
  }, [entry]);

  const patch = useMemo(() => {
    if (!entry) return null;
    const trimmedSummary = summary.trim();
    const p: { summary?: string; type?: string; body?: string } = {};
    if (trimmedSummary && trimmedSummary !== entry.summary) p.summary = trimmedSummary;
    if (type !== entry.type) p.type = type;
    if (body !== (entry.body ?? '')) p.body = body;
    return p;
  }, [entry, summary, type, body]);

  const hasChanges = !!patch && Object.keys(patch).length > 0;
  const summaryEmpty = summary.trim().length === 0;
  const bodyTooShort = body.trim().length < MIN_MEMORY_CHARS;

  const handleSave = async (): Promise<void> => {
    if (!entry || !patch || !hasChanges || summaryEmpty || bodyTooShort || saving) return;
    setSaving(true);
    try {
      const result = await memoryBridge.updateEntry.invoke({ id: entry.id, ...patch });
      if (result.ok) {
        Message.success(
          t('archive.editor.toastSaved', 'Memory updated. The brain keeps the old version as superseded.')
        );
        onSaved(result.newId ?? entry.id);
        onClose();
      } else {
        Message.error(result.error || t('archive.editor.toastError', 'Could not update memory'));
      }
    } catch (err) {
      Message.error(
        err instanceof Error && err.message ? err.message : t('archive.editor.toastError', 'Could not update memory')
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t('archive.editor.title', 'Edit memory')}
      visible={open}
      onCancel={onClose}
      onOk={() => {
        void handleSave();
      }}
      okButtonProps={{ disabled: !hasChanges || summaryEmpty || bodyTooShort, loading: saving }}
      okText={t('archive.editor.save', 'Save')}
      cancelText={t('archive.editor.cancel', 'Cancel')}
      unmountOnExit
      data-testid='entry-editor-modal'
    >
      <div className='flex flex-col gap-12px'>
        {entry && (
          <p className='m-0 text-12px text-[var(--color-text-3)]' data-testid='entry-editor-workspace'>
            {t('archive.editor.workspaceNote', 'Saved in the {{workspace}} workspace. Saving writes a new version.', {
              workspace: entry.project,
            })}
          </p>
        )}
        <label className='flex flex-col gap-4px'>
          <span className='text-12px text-[var(--color-text-3)]'>{t('archive.editor.summaryLabel', 'Summary')}</span>
          <Input
            value={summary}
            onChange={setSummary}
            maxLength={500}
            data-testid='entry-editor-summary'
            status={summaryEmpty ? 'error' : undefined}
          />
        </label>
        <label className='flex flex-col gap-4px'>
          <span className='text-12px text-[var(--color-text-3)]'>{t('archive.editor.typeLabel', 'Category')}</span>
          <Select value={type} onChange={(v) => setType(v as MemoryType)} data-testid='entry-editor-type'>
            {MEMORY_CATEGORIES.map((c) => (
              <Select.Option key={c.type} value={c.type}>
                {t(c.labelKey, c.label)} - {t(c.descriptionKey, c.description)}
              </Select.Option>
            ))}
          </Select>
        </label>
        <label className='flex flex-col gap-4px'>
          <span className='text-12px text-[var(--color-text-3)]'>{t('archive.editor.bodyLabel', 'Body')}</span>
          <Input.TextArea
            value={body}
            onChange={setBody}
            autoSize={{ minRows: 6, maxRows: 16 }}
            data-testid='entry-editor-body'
            status={bodyTooShort ? 'error' : undefined}
          />
          <span
            className={`text-12px ${bodyTooShort ? 'text-[rgb(var(--danger-6))]' : 'text-[var(--color-text-3)]'}`}
            data-testid='entry-editor-min-hint'
          >
            {t('archive.editor.minHint', 'At least {{min}} characters', { min: MIN_MEMORY_CHARS })}
          </span>
        </label>
      </div>
    </Modal>
  );
};

export default EntryEditorModal;
