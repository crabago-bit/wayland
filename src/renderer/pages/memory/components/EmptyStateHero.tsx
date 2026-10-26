/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EmptyStateHero - full-area hero shown when the brain holds no memories yet.
 *
 * Contains: search input (44px), headline, subline and an Add button. Notes can
 * also be dropped anywhere on the page (FullPanelShell handles the drop).
 */

import React from 'react';
import { Button, Input } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import styles from './EmptyStateHero.module.css';

export type EmptyStateHeroProps = {
  onSearchChange?: (val: string) => void;
  /** Open the composer. */
  onAdd?: () => void;
};

const EmptyStateHero: React.FC<EmptyStateHeroProps> = ({ onSearchChange, onAdd }) => {
  const { t } = useTranslation('memory');

  return (
    <div className={styles.hero} data-testid='empty-state-hero'>
      <div className={styles.searchWrap}>
        <Input
          className={styles.searchInput}
          placeholder={t('archive.empty.search', 'Search memories… (type:decision tag:design)')}
          allowClear
          onChange={(val) => onSearchChange?.(val)}
          data-testid='empty-hero-search'
        />
      </div>

      <h2 className={styles.headline} data-testid='empty-hero-headline'>
        {t('archive.empty.headline', 'Your brain has no memories yet.')}
      </h2>
      <p className={styles.subline} data-testid='empty-hero-subline'>
        {t('archive.empty.subline', 'Add one with Add, or drop .md/.txt/.json notes anywhere on this page.')}
      </p>

      {onAdd && (
        <Button type='primary' onClick={onAdd} data-testid='empty-hero-add'>
          {t('archive.topbar.add', 'Add')}
        </Button>
      )}
    </div>
  );
};

export default EmptyStateHero;
