/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ComposerModal - centered modal for saving a new memory to the brain.
 *
 * The user picks a category (Decisions, Preferences, ...) and a brain workspace.
 * The backend titles the memory so it classifies back into the chosen category.
 * The brain refuses memories under {@link MIN_MEMORY_CHARS} characters, so the
 * modal shows the minimum and blocks shorter saves; any refusal the backend
 * returns is shown as-is in a toast.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Message, Modal } from '@arco-design/web-react';
import { X } from 'lucide-react';
import { memory as memoryBridge } from '@/common/adapter/ipcBridge';
import type { MemoryType } from '@/common/types/memory';
import { useTranslation } from 'react-i18next';
import { GLOBAL_WORKSPACE, MEMORY_CATEGORIES, MIN_MEMORY_CHARS } from '../categories';
import styles from './ComposerModal.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComposerModalProps = {
  open: boolean;
  onClose: () => void;
  /** Brain workspaces the memory can be saved to. `general` is always offered. */
  workspaces?: ReadonlyArray<string>;
  /** Workspace selected on open: the page's workspace filter, else `general`. */
  defaultWorkspace?: string;
};

const MAX_CHARS = 8000;
const DEFAULT_CATEGORY: MemoryType = 'observation';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ComposerModal({
  open,
  onClose,
  workspaces = [],
  defaultWorkspace,
}: ComposerModalProps): React.ReactElement | null {
  const { t } = useTranslation('memory');

  const [content, setContent] = useState('');
  const [category, setCategory] = useState<MemoryType>(DEFAULT_CATEGORY);
  const [workspace, setWorkspace] = useState<string>(GLOBAL_WORKSPACE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Seed on open, reset on close. The workspace is seeded once per open so a
  // background index refresh cannot move the destination under the user.
  const seededRef = useRef(false);
  useEffect(() => {
    if (open) {
      if (!seededRef.current) {
        seededRef.current = true;
        setWorkspace(defaultWorkspace || GLOBAL_WORKSPACE);
      }
      const id = window.setTimeout(() => {
        textareaRef.current?.focus();
      }, 60);
      return () => window.clearTimeout(id);
    }
    seededRef.current = false;
    setContent('');
    setCategory(DEFAULT_CATEGORY);
    setWorkspace(GLOBAL_WORKSPACE);
    setError(null);
    return undefined;
  }, [open, defaultWorkspace]);

  // `general` first, then the rest in the order given, without duplicates.
  const workspaceOptions = [GLOBAL_WORKSPACE, ...workspaces.filter((w) => w && w !== GLOBAL_WORKSPACE)];
  if (!workspaceOptions.includes(workspace)) workspaceOptions.push(workspace);

  const trimmedLength = content.trim().length;
  const tooShort = trimmedLength < MIN_MEMORY_CHARS;
  const charOverLimit = content.length > MAX_CHARS;

  // ---- Submit ----
  const handleSubmit = useCallback(async () => {
    const trimmed = content.trim();
    if (trimmed.length < MIN_MEMORY_CHARS) {
      setError(
        t('archive.composer.errorTooShort', 'A brain memory needs at least {{min}} characters.', {
          min: MIN_MEMORY_CHARS,
        })
      );
      return;
    }
    if (trimmed.length > MAX_CHARS) {
      setError(
        t('archive.composer.errorTooLong', 'Content exceeds {{max}} character limit.', {
          max: MAX_CHARS,
        })
      );
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await memoryBridge.setQuickAdd.invoke({
        content: trimmed,
        scope: workspace === GLOBAL_WORKSPACE ? 'global' : 'project',
        type: category,
        projectPath: `brain://${workspace}`,
      });
      if (!result?.ok) {
        const message = result?.error || t('archive.composer.errorUnknown', 'Failed to save.');
        setError(message);
        Message.error(message);
        return;
      }
      Message.success(t('archive.composer.toastSaved', 'Memory saved to your brain'));
      onClose();
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : t('archive.composer.errorUnknown', 'Failed to save.');
      setError(message);
      Message.error(message);
    } finally {
      setSubmitting(false);
    }
  }, [content, category, workspace, onClose, t]);

  // ---- Cmd/Ctrl+Enter to submit ----
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  // ---- Drag-drop a file into the textarea ----
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      // Keep the drop from also reaching the page-level ingest handler.
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result;
        if (typeof text === 'string') {
          const block = content.trim() ? `${content}\n\n\`\`\`\n${text}\n\`\`\`` : text;
          setContent(block);
        }
      };
      reader.readAsText(file);
    },
    [content]
  );

  if (!open) return null;

  const charCount = content.length;
  const selectedCategory = MEMORY_CATEGORIES.find((c) => c.type === category);

  return (
    <Modal
      visible={open}
      onCancel={onClose}
      title={null}
      footer={null}
      closable={false}
      maskClosable
      className={styles.modal}
      data-testid='composer-modal'
      getPopupContainer={() => document.body}
    >
      <div className={styles.inner}>
        {/* ---- Header ---- */}
        <div className={styles.header}>
          <h2 className={styles.title} data-testid='composer-title'>
            {t('archive.composer.title', 'Remember anything…')}
          </h2>
          <button
            className={styles.closeBtn}
            onClick={onClose}
            aria-label={t('archive.composer.close', 'Close')}
            data-testid='composer-close-btn'
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {/* ---- Textarea ---- */}
        <div className={styles.textareaWrap}>
          <Input.TextArea
            ref={(el) => {
              if (el) {
                const ta = (el as unknown as { dom?: HTMLTextAreaElement }).dom;
                if (ta) textareaRef.current = ta;
              }
            }}
            className={`${styles.textarea}${charOverLimit ? ` ${styles.textareaError}` : ''}`}
            placeholder={t('archive.composer.placeholder', 'Type your memory… (markdown OK)')}
            value={content}
            onChange={(val) => {
              setContent(val);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            disabled={submitting}
            autoSize={{ minRows: 8, maxRows: 14 }}
            data-testid='composer-textarea'
          />
          <div className={styles.textareaFooter}>
            {error ? (
              <span className={styles.errorMsg} role='alert' data-testid='composer-error'>
                {error}
              </span>
            ) : (
              <span className={styles.footerHint} data-testid='composer-min-hint'>
                {t('archive.composer.minHint', 'At least {{min}} characters', { min: MIN_MEMORY_CHARS })}
              </span>
            )}
            <span
              className={`${styles.charCount}${charOverLimit ? ` ${styles.charCountOver}` : ''}`}
              aria-label={`${charCount} characters`}
            >
              {charCount.toLocaleString()}/{MAX_CHARS.toLocaleString()}
            </span>
          </div>
        </div>

        {/* ---- Category ---- */}
        <div className={styles.scopeRow} role='radiogroup' data-testid='composer-category-row'>
          {MEMORY_CATEGORIES.map((c) => (
            <button
              key={c.type}
              type='button'
              role='radio'
              className={`${styles.scopePill}${category === c.type ? ` ${styles.scopePillActive}` : ''}`}
              onClick={() => setCategory(c.type)}
              aria-checked={category === c.type}
              title={t(c.descriptionKey, c.description)}
              data-testid={`composer-category-${c.type}`}
            >
              <span aria-hidden style={{ color: c.color }}>
                {c.glyph}
              </span>
              {t(c.labelKey, c.label)}
            </button>
          ))}
        </div>
        {selectedCategory && (
          <p className={styles.categoryHint} data-testid='composer-category-description'>
            {t(selectedCategory.descriptionKey, selectedCategory.description)}
          </p>
        )}

        {/* ---- Workspace ---- */}
        <div className={styles.scopeRow} data-testid='composer-destination-row'>
          <label className={styles.workspaceLabel}>
            {t('archive.composer.workspace', 'Brain workspace')}
            <select
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              aria-label={t('archive.composer.workspacePicker', 'Brain workspace to save to')}
              data-testid='composer-workspace-picker'
            >
              {workspaceOptions.map((w) => (
                <option key={w} value={w}>
                  {w === GLOBAL_WORKSPACE
                    ? t('archive.composer.generalWorkspace', 'general (shared by every agent)')
                    : w}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* ---- Drop zone ---- */}
        <div
          className={styles.dropZone}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          data-testid='composer-drop-zone'
          role='region'
          aria-label={t('archive.composer.dropZoneLabel', 'Drop a file to paste its text')}
        >
          {t('archive.composer.dropZone', 'or drop a file to paste its text here')}
        </div>

        {/* ---- Footer ---- */}
        <div className={styles.footer}>
          <span className={styles.footerHint}>⌘↵ {t('archive.composer.hint', 'to Remember')}</span>
          <div className={styles.footerActions}>
            <Button onClick={onClose} disabled={submitting} data-testid='composer-cancel-btn'>
              {t('archive.composer.cancel', 'Cancel')}
            </Button>
            <Button
              type='primary'
              loading={submitting}
              disabled={tooShort || charOverLimit}
              onClick={() => void handleSubmit()}
              data-testid='composer-submit-btn'
              className={styles.submitBtn}
            >
              {t('archive.composer.submit', 'Remember')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default ComposerModal;
