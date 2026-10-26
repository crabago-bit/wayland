/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CardsView - the same memories as the list, as a grid of cards: category, title, a few lines of
 * the body and when it was stored. Scrolling to the end loads more, like the list.
 */

import React from 'react';
import { VirtuosoGrid } from 'react-virtuoso';
import type { MemoryEntry } from '@/common/types/memory';
import { categoryOf } from '../categories';
import styles from './CardsView.module.css';

export type CardsViewProps = {
  entries: MemoryEntry[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  onEndReached?: () => void;
};

const formatDate = (ms: number): string =>
  ms > 0 ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

const CardsView: React.FC<CardsViewProps> = ({ entries, selectedId, onSelect, onEndReached }) => {
  if (entries.length === 0) {
    return (
      <div className={styles.empty} data-testid='memory-cards-empty'>
        No matches. Try removing a filter or clearing the search.
      </div>
    );
  }
  return (
    <VirtuosoGrid
      style={{ height: '100%' }}
      totalCount={entries.length}
      endReached={onEndReached}
      listClassName={styles.grid}
      data-testid='memory-cards'
      itemContent={(index) => {
        const entry = entries[index];
        if (!entry) return null;
        const cat = categoryOf(entry.type);
        return (
          <button
            type='button'
            className={`${styles.card}${entry.id === selectedId ? ` ${styles.cardSelected}` : ''}`}
            onClick={() => onSelect?.(entry.id)}
            data-testid={`memory-card-${entry.id}`}
          >
            <span className={styles.chip} style={{ color: cat?.color }}>
              {cat?.glyph} {cat?.label ?? entry.type}
            </span>
            <span className={styles.title}>{entry.summary}</span>
            <span className={styles.preview}>{entry.bodyPreview}</span>
            <span className={styles.meta}>
              {entry.project} · {formatDate(entry.storedAt)}
            </span>
          </button>
        );
      }}
    />
  );
};

export default CardsView;
