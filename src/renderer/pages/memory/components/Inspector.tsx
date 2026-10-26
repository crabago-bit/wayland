/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inspector - right-pane detail view for the Memory Archive page.
 *
 * Pure presentational. Receives a MemoryEntry with its body and emits
 * Copy / Edit / Archive callbacks upward.
 *
 * Esc-to-close is registered via a keydown listener while mounted.
 */

import React, { useEffect } from 'react';
import { Button, Tag } from '@arco-design/web-react';
import { Close, Copy, Edit, FileCode, Inbox } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { MemoryEntry, MemoryType } from '@/common/types/memory';
import { categoryOf } from '../categories';
import styles from './Inspector.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExtendedEntry = MemoryEntry & { body: string };

export type InspectorProps = {
  entry: ExtendedEntry | null;
  onClose?: () => void;
  onCopy?: (text: string) => void;
  onEdit?: (entry: ExtendedEntry) => void;
  onArchive?: (entry: ExtendedEntry) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatRelative = (ts: number): string => {
  const diff = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState(): React.ReactElement {
  return (
    <div className={styles.empty} data-testid='inspector-empty'>
      <FileCode className={styles.emptyIcon} theme='outline' size='32' aria-hidden data-testid='inspector-empty-icon' />
      <span>Select a memory to inspect it</span>
      <div className={styles.emptyHint}>
        <span className={styles.kbdChip}>↑/↓ navigate</span>
        <span className={styles.kbdChip}>Enter select</span>
        <span className={styles.kbdChip}>Esc close</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector (exported)
// ---------------------------------------------------------------------------

const Inspector: React.FC<InspectorProps> = ({ entry, onClose, onCopy, onEdit, onArchive }) => {
  const { t } = useTranslation('memory');

  // Esc-to-close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose?.();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (entry === null) {
    return (
      <div className={styles.root}>
        <EmptyState />
      </div>
    );
  }

  const category = categoryOf(entry.type);
  const sourceTags = (entry.tags ?? []).filter((tag) => tag !== entry.type);

  const typeBadgeClass = (tp: MemoryType): string => {
    const map: Record<MemoryType, string> = {
      decision: styles.decision,
      pattern: styles.pattern,
      observation: styles.observation,
      session: styles.session,
      wiki: styles.wiki,
      preference: styles.preference,
    };
    return map[tp] ?? '';
  };

  return (
    <div className={styles.root} data-testid='inspector-root'>
      {/* ---- Header ---- */}
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <Button
            className={styles.closeBtn}
            shape='circle'
            size='mini'
            type='secondary'
            icon={<Close theme='outline' size='12' />}
            onClick={() => onClose?.()}
            aria-label={t('archive.inspector.close', 'Close inspector')}
            data-testid='inspector-close'
          />
          <h2 className={styles.title} data-testid='inspector-title'>
            {entry.summary}
          </h2>
          <div className={styles.meta}>
            <span title={new Date(entry.storedAt).toLocaleString()}>{formatRelative(entry.storedAt)}</span>
            <span>·</span>
            <span data-testid='inspector-workspace'>{entry.project}</span>
            <span
              className={[styles.typeBadge, typeBadgeClass(entry.type)].join(' ')}
              title={t(category.descriptionKey, category.description)}
              data-testid='inspector-type-badge'
            >
              {category.glyph} {t(category.labelKey, category.label)}
            </span>
          </div>
        </div>

        {/* ---- Actions ---- */}
        <div className={styles.actions}>
          <Button
            type='text'
            size='small'
            icon={<Copy theme='outline' size='13' />}
            onClick={() => onCopy?.(entry.body)}
            data-testid='inspector-copy-btn'
          >
            {t('archive.drawer.copy', 'Copy')}
          </Button>
          <Button
            type='text'
            size='small'
            icon={<Edit theme='outline' size='13' />}
            onClick={() => onEdit?.(entry)}
            data-testid='inspector-edit-btn'
          >
            {t('archive.drawer.edit', 'Edit')}
          </Button>
          <Button
            type='text'
            size='small'
            icon={<Inbox theme='outline' size='13' />}
            onClick={() => onArchive?.(entry)}
            data-testid='inspector-archive-btn'
          >
            {t('archive.drawer.delete', 'Archive')}
          </Button>
        </div>
      </div>

      {/* ---- Scrollable body ---- */}
      <div className={styles.body}>
        <div className={styles.section} data-testid='inspector-section-category'>
          <h3 className={styles.sectionLabel}>{t('archive.drawer.category', 'Category')}</h3>
          <div className={styles.sectionContent}>
            <p>
              {t(category.labelKey, category.label)} - {t(category.descriptionKey, category.description)}
            </p>
          </div>
        </div>

        <div className={styles.section} data-testid='inspector-section-stored'>
          <h3 className={styles.sectionLabel}>{t('archive.drawer.stored', 'Stored')}</h3>
          <div className={styles.sectionContent}>
            <p>{new Date(entry.storedAt).toLocaleString()}</p>
          </div>
        </div>

        {sourceTags.length > 0 && (
          <div className={styles.section} data-testid='inspector-section-tags'>
            <h3 className={styles.sectionLabel}>{t('archive.drawer.source', 'Source')}</h3>
            <div className={styles.tagRow}>
              {sourceTags.map((tag) => (
                <Tag key={tag} size='small' color='arcoblue'>
                  {tag}
                </Tag>
              ))}
            </div>
          </div>
        )}

        <div className={styles.section} data-testid='inspector-section-body'>
          <h3 className={styles.sectionLabel}>{t('archive.drawer.memory', 'Memory')}</h3>
          <div className={styles.sectionContent} style={{ whiteSpace: 'pre-wrap' }} data-testid='inspector-body'>
            {entry.body.trim() ? (
              entry.body
            ) : (
              <span className={styles.sectionAbsent}>
                {t('archive.drawer.noBody', 'This memory has no body text.')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Inspector;
