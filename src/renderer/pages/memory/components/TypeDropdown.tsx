/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TypeDropdown - "All types ▾" multi-select filter dropdown.
 *
 * One row per category (all six): colored dot + label + count from stats.typeCounts,
 * with the category's plain-language meaning as the row tooltip.
 * onFilterChange fires with updated MemoryType array.
 */

import React, { useCallback } from 'react';
import { Dropdown } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { MemoryType } from '@/common/types/memory';
import { MEMORY_CATEGORIES, categoryOf } from '../categories';
import styles from './TypeDropdown.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TypeDropdownProps = {
  typeCounts: Record<MemoryType, number>;
  selected: MemoryType[];
  onFilterChange: (types: MemoryType[]) => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TypeDropdown: React.FC<TypeDropdownProps> = ({ typeCounts, selected, onFilterChange }) => {
  const { t } = useTranslation('memory');

  const toggleType = useCallback(
    (type: MemoryType) => {
      const next = selected.includes(type) ? selected.filter((s) => s !== type) : [...selected, type];
      onFilterChange(next);
    },
    [selected, onFilterChange]
  );

  const selectedLabel =
    selected.length === 0
      ? t('archive.filter.allTypes', 'All types')
      : selected.length === 1
        ? t(categoryOf(selected[0] as MemoryType).labelKey, categoryOf(selected[0] as MemoryType).label)
        : `${selected.length} ${t('archive.filter.typesSelected', 'types')}`;

  const dropdownContent = (
    <div className={styles.panel} data-testid='type-dropdown-panel'>
      {MEMORY_CATEGORIES.map((def) => {
        const isChecked = selected.includes(def.type);
        const count = typeCounts[def.type] ?? 0;

        return (
          <button
            key={def.type}
            type='button'
            className={`${styles.row}${isChecked ? ` ${styles.rowChecked}` : ''}`}
            onClick={() => toggleType(def.type)}
            title={t(def.descriptionKey, def.description)}
            data-testid={`type-option-${def.type}`}
          >
            <span className={styles.dot} style={{ background: def.color }} aria-hidden />
            <span className={styles.typeLabel}>{t(def.labelKey, def.label)}</span>
            <span className={styles.typeCount}>{count.toLocaleString()}</span>
            <span className={styles.check} aria-hidden>
              {isChecked ? '✓' : ''}
            </span>
          </button>
        );
      })}
      {selected.length > 0 && (
        <button
          type='button'
          className={styles.clearBtn}
          onClick={() => onFilterChange([])}
          data-testid='type-clear-btn'
        >
          {t('archive.filter.clearAll', 'Clear all')}
        </button>
      )}
    </div>
  );

  return (
    <Dropdown droplist={dropdownContent} trigger='click' position='bl'>
      <button
        type='button'
        className={`${styles.trigger}${selected.length > 0 ? ` ${styles.triggerActive}` : ''}`}
        data-testid='type-dropdown-btn'
      >
        {selectedLabel}
        <span className={styles.arrow} aria-hidden>
          ▾
        </span>
      </button>
    </Dropdown>
  );
};

export default TypeDropdown;
