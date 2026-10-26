/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RelatedMemories - the memories that share the most with the open one (same files, hosts,
 * identifiers), each with the terms that link them. Fetches for itself; renders nothing when
 * there is nothing related or the lookup is unavailable.
 */

import React, { useEffect, useState } from 'react';
import { memory as memoryBridge } from '@/common/adapter/ipcBridge';
import type { MemoryRelated } from '@/common/types/memory';
import { categoryOf } from '../categories';
import styles from './RelatedMemories.module.css';

export type RelatedMemoriesProps = {
  entryId: string;
  onOpen: (id: string) => void;
  /** Heading text, and the drawer's own classes so the section matches its neighbours. */
  label: string;
  sectionClassName?: string;
  headingClassName?: string;
};

const RelatedMemories: React.FC<RelatedMemoriesProps> = ({
  entryId,
  onOpen,
  label,
  sectionClassName,
  headingClassName,
}) => {
  const [related, setRelated] = useState<MemoryRelated[]>([]);

  useEffect(() => {
    let cancelled = false;
    setRelated([]);
    void (async () => {
      try {
        const provider = memoryBridge?.getRelated;
        if (!provider || typeof provider.invoke !== 'function') return;
        const next = await provider.invoke({ id: entryId });
        if (!cancelled && Array.isArray(next)) setRelated(next);
      } catch {
        if (!cancelled) setRelated([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  if (related.length === 0) return null;
  return (
    <div className={sectionClassName} data-testid='drawer-section-related'>
      <h3 className={headingClassName}>{label}</h3>
      <ul className={styles.list} data-testid='related-memories'>
        {related.map((r) => {
          const cat = categoryOf(r.type);
          return (
            <li key={r.id}>
              <button
                type='button'
                className={styles.item}
                onClick={() => onOpen(r.id)}
                data-testid={`related-${r.id}`}
              >
                <span className={styles.glyph} style={{ color: cat.color }} aria-hidden>
                  {cat.glyph}
                </span>
                <span className={styles.text}>
                  <span className={styles.title}>{r.summary}</span>
                  <span className={styles.terms}>{r.terms.slice(0, 3).join(' · ')}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default RelatedMemories;
