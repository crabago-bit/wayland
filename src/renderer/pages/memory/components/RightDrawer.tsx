/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RightDrawer - 480px push-content drawer shell for the Memory Archive.
 *
 * Renders nothing when entry === null.
 * Width transitions 0→480 over 0.22s via CSS - push-content, NOT overlay.
 * The list column must have a synchronized margin-right transition.
 *
 * Shows a brain memory: its workspace, category (with what that category
 * means), stored date, source labels and full body, plus Copy / Edit / Archive.
 */

import React, { useEffect } from 'react';
import { Button, Tag } from '@arco-design/web-react';
import { Close, Copy, Edit, Inbox } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import type { MemoryEntry } from '@/common/types/memory';
import { categoryOf } from '../categories';
import styles from './RightDrawer.module.css';

type ExtendedEntry = MemoryEntry & { body: string };

export type RightDrawerProps = {
  entry: ExtendedEntry | null;
  onClose: () => void;
  onCopy?: (text: string) => void;
  /** Open the editor for this entry. */
  onEdit?: (entry: ExtendedEntry) => void;
  /** Archive this entry after confirmation. */
  onArchive?: (entry: ExtendedEntry) => void;
};

const formatRelative = (ts: number): string => {
  const diff = Math.max(0, Date.now() - ts);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

/** Source labels: the entry's tags minus the category itself (already shown as the badge). */
export const sourceLabels = (entry: Pick<MemoryEntry, 'tags' | 'type'>): string[] =>
  (entry.tags ?? []).filter((tag) => tag !== entry.type);

const RightDrawer: React.FC<RightDrawerProps> = ({ entry, onClose, onCopy, onEdit, onArchive }) => {
  const { t } = useTranslation('memory');

  // Esc closes drawer
  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const isOpen = entry !== null;
  const category = entry ? categoryOf(entry.type) : null;
  const labels = entry ? sourceLabels(entry) : [];

  return (
    <div
      className={`${styles.drawer}${isOpen ? ` ${styles.drawerOpen}` : ''}`}
      data-testid='right-drawer'
      aria-hidden={!isOpen}
    >
      {isOpen && category && (
        <div className={styles.inner} data-testid='right-drawer-inner'>
          {/* Header */}
          <div className={styles.header}>
            <div className={styles.headerTop}>
              <Button
                className={styles.closeBtn}
                shape='circle'
                size='mini'
                type='secondary'
                icon={<Close theme='outline' size='12' />}
                onClick={onClose}
                aria-label={t('archive.drawer.close', 'Close drawer')}
                data-testid='drawer-close-btn'
              />
              <h2 className={styles.title} data-testid='drawer-title'>
                {entry.summary}
              </h2>
            </div>

            {/* Meta row */}
            <div className={styles.meta} data-testid='drawer-meta'>
              <span
                className={styles.typeBadge}
                style={{ background: `${category.color}22`, color: category.color }}
                title={t(category.descriptionKey, category.description)}
                data-testid='drawer-type-badge'
              >
                {category.glyph} {t(category.labelKey, category.label)}
              </span>
              <span className={styles.metaSep}>·</span>
              <span className={styles.metaDate} title={new Date(entry.storedAt).toLocaleString()}>
                {formatRelative(entry.storedAt)}
              </span>
              <span className={styles.metaSep}>·</span>
              <span className={styles.metaProject} data-testid='drawer-project'>
                {entry.project}
              </span>
            </div>
          </div>

          {/* Action row */}
          <div className={styles.actions} data-testid='drawer-actions'>
            <Button
              type='text'
              size='small'
              icon={<Copy theme='outline' size='13' />}
              onClick={() => onCopy?.(entry.body)}
              data-testid='drawer-copy-btn'
            >
              {t('archive.drawer.copy', 'Copy')}
            </Button>
            <Button
              type='text'
              size='small'
              icon={<Edit theme='outline' size='13' />}
              onClick={() => onEdit?.(entry)}
              data-testid='drawer-edit-btn'
            >
              {t('archive.drawer.edit', 'Edit')}
            </Button>
            <Button
              type='text'
              size='small'
              icon={<Inbox theme='outline' size='13' />}
              onClick={() => onArchive?.(entry)}
              data-testid='drawer-archive-btn'
            >
              {t('archive.drawer.delete', 'Archive')}
            </Button>
          </div>

          {/* Scrollable body */}
          <div className={styles.body} data-testid='drawer-body'>
            <div className={styles.section} data-testid='drawer-section-details'>
              <h3 className={styles.sectionLabel}>{t('archive.drawer.details', 'Details')}</h3>
              <dl className={styles.details}>
                <dt>{t('archive.drawer.workspace', 'Workspace')}</dt>
                <dd data-testid='drawer-workspace'>{entry.project}</dd>
                <dt>{t('archive.drawer.category', 'Category')}</dt>
                <dd data-testid='drawer-category'>
                  {t(category.labelKey, category.label)}
                  <span className={styles.absent}> - {t(category.descriptionKey, category.description)}</span>
                </dd>
                <dt>{t('archive.drawer.stored', 'Stored')}</dt>
                <dd data-testid='drawer-stored'>{new Date(entry.storedAt).toLocaleString()}</dd>
              </dl>
            </div>

            {labels.length > 0 && (
              <div className={styles.section} data-testid='drawer-section-tags'>
                <h3 className={styles.sectionLabel}>{t('archive.drawer.source', 'Source')}</h3>
                <div className={styles.tagRow}>
                  {labels.map((tag) => (
                    <Tag key={tag} size='small' color='arcoblue'>
                      {tag}
                    </Tag>
                  ))}
                </div>
              </div>
            )}

            <div className={styles.section} data-testid='drawer-section-body'>
              <h3 className={styles.sectionLabel}>{t('archive.drawer.memory', 'Memory')}</h3>
              <div className={styles.sectionContent} data-testid='drawer-body-text'>
                {entry.body.trim() ? (
                  <ReactMarkdown>{entry.body}</ReactMarkdown>
                ) : (
                  <span className={styles.absent}>{t('archive.drawer.noBody', 'This memory has no body text.')}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RightDrawer;
