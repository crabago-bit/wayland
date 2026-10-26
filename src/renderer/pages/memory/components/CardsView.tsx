/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CardsView - the same memories as the list, as cards grouped under their category: a header
 * with the count, then a grid of cards with title, a few lines of body and the date. Scrolling
 * near the end loads more, like the list.
 */

import React, { useCallback, useMemo } from 'react';
import type { MemoryEntry, MemoryType } from '@/common/types/memory';
import { MEMORY_CATEGORIES } from '../categories';
import styles from './CardsView.module.css';

export type CardsViewProps = {
  entries: MemoryEntry[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  onEndReached?: () => void;
};

const END_REACHED_PX = 400;

const formatDate = (ms: number): string =>
  ms > 0 ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

const CardsView: React.FC<CardsViewProps> = ({ entries, selectedId, onSelect, onEndReached }) => {
  const groups = useMemo(() => {
    const byType = new Map<MemoryType, MemoryEntry[]>();
    for (const entry of entries) {
      const list = byType.get(entry.type);
      if (list) list.push(entry);
      else byType.set(entry.type, [entry]);
    }
    return MEMORY_CATEGORIES.filter((c) => byType.has(c.type)).map((c) => ({
      category: c,
      entries: byType.get(c.type)!,
    }));
  }, [entries]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < END_REACHED_PX) onEndReached?.();
    },
    [onEndReached]
  );

  if (entries.length === 0) {
    return (
      <div className={styles.empty} data-testid='memory-cards-empty'>
        No matches. Try removing a filter or clearing the search.
      </div>
    );
  }

  return (
    <div className={styles.scroll} onScroll={handleScroll} data-testid='memory-cards'>
      {groups.map(({ category, entries: items }) => (
        <section key={category.type} className={styles.section} data-testid={`memory-cards-group-${category.type}`}>
          <h3 className={styles.groupHeader} style={{ color: category.color }}>
            {category.glyph} {category.label}
            <span className={styles.groupCount}>{items.length.toLocaleString()}</span>
          </h3>
          <div className={styles.grid}>
            {items.map((entry) => (
              <button
                key={entry.id}
                type='button'
                className={`${styles.card}${entry.id === selectedId ? ` ${styles.cardSelected}` : ''}`}
                onClick={() => onSelect?.(entry.id)}
                data-testid={`memory-card-${entry.id}`}
              >
                <span className={styles.title}>{entry.summary}</span>
                <span className={styles.preview}>{entry.bodyPreview}</span>
                <span className={styles.meta}>
                  {entry.project} · {formatDate(entry.storedAt)}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};

export default CardsView;
