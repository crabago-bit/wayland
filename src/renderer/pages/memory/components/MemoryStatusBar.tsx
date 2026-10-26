/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MemoryStatusBar - 28px bottom strip.
 *
 * Left: pulse dot + "Brain live" + total memory count.
 * Right: kbd hints ⌘K / J K / / / Esc (K9 fix).
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatModifierShortcut } from '@/renderer/utils/platform';
import styles from './MemoryStatusBar.module.css';

export type MemoryStatusBarProps = {
  brainLive: boolean;
  /** Memories currently in the brain (across all workspaces). */
  total: number;
};

const MemoryStatusBar: React.FC<MemoryStatusBarProps> = ({ brainLive, total }) => {
  const { t } = useTranslation('memory');

  return (
    <div className={styles.bar} role='status' data-testid='memory-status-bar'>
      {/* Left: status info */}
      <div className={styles.left}>
        <span className={styles.pill} data-testid='status-brain-pill'>
          <span className={`${styles.dot} ${brainLive ? styles.dotLive : styles.dotOffline}`} aria-hidden />
          <span>
            {brainLive
              ? t('archive.status.brainLive', 'Brain live')
              : t('archive.status.brainOffline', 'Brain offline')}
          </span>
        </span>

        <span className={styles.sep} aria-hidden>
          ·
        </span>
        <span className={styles.pill} data-testid='status-total-pill'>
          {t('archive.status.total', '{{n}} memories', { n: total.toLocaleString() })}
        </span>
      </div>

      {/* Right: kbd hints (K9) */}
      <div className={styles.right}>
        <span className={styles.kbd} data-testid='status-kbd-search'>
          {formatModifierShortcut('K')}
        </span>
        <span className={styles.kbdLabel}>{t('archive.status.kbd.search', 'search')}</span>
        <span className={styles.kbdSep} aria-hidden>
          ·
        </span>
        <span className={styles.kbd} data-testid='status-kbd-nav-j'>
          J
        </span>
        <span className={styles.kbd} data-testid='status-kbd-nav-k'>
          K
        </span>
        <span className={styles.kbdLabel}>{t('archive.status.kbd.navigate', 'navigate')}</span>
        <span className={styles.kbdSep} aria-hidden>
          ·
        </span>
        <span className={styles.kbd} data-testid='status-kbd-focus'>
          {formatModifierShortcut('K')}
        </span>
        <span className={styles.kbdLabel}>/</span>
        <span className={styles.kbdSep} aria-hidden>
          ·
        </span>
        <span className={styles.kbd} data-testid='status-kbd-close'>
          Esc
        </span>
        <span className={styles.kbdLabel}>{t('archive.status.kbd.close', 'close')}</span>
      </div>
    </div>
  );
};

export default MemoryStatusBar;
