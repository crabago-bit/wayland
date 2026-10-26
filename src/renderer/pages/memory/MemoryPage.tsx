/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Memory page shell.
 *
 * Memory lives in the user's brain MCP server. The page asks the main process
 * which backend is available: `brain` renders the full archive, `none` (or any
 * failure to ask) renders a card pointing at Settings.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import FullPanelShell from './state-branches/FullPanelShell';
import styles from './MemoryPage.module.css';

type Backend = 'brain' | 'none';

const MemoryPage: React.FC = () => {
  const { t } = useTranslation('memory');
  const [backend, setBackend] = useState<Backend | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The async IIFE + try/catch covers both a synchronous throw from invoke()
    // and a rejected promise.
    void (async () => {
      let kind: Backend = 'none';
      try {
        const provider = ipcBridge.memory?.getBackend;
        if (provider && typeof provider.invoke === 'function') {
          kind = (await provider.invoke()) === 'brain' ? 'brain' : 'none';
        }
      } catch {
        kind = 'none';
      }
      if (!cancelled) setBackend(kind);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (backend === 'brain') {
    // FullPanelShell is a full-bleed grid that owns its own header.
    return (
      <div className={styles.pageFullBleed} data-testid='memory-page' role='region' aria-label='Memory'>
        <FullPanelShell />
      </div>
    );
  }

  return (
    <div className={styles.page} data-testid='memory-page' role='region' aria-label='Memory'>
      {backend === null ? (
        <div className={styles.center} data-testid='memory-loading' role='status' aria-busy='true' aria-live='polite'>
          <p className='text-14px text-t-secondary m-0'>{t('page.loading', 'Connecting to your brain…')}</p>
        </div>
      ) : (
        <div className={styles.center}>
          <div className={styles.card} data-testid='memory-no-brain'>
            <h2 className={styles.cardTitle}>{t('page.noBrain.title', 'Connect your brain')}</h2>
            <p className={styles.cardBody}>
              {t('page.noBrain.body', 'No MCP server named brain is configured. Add one in Settings to use Memory.')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default MemoryPage;
