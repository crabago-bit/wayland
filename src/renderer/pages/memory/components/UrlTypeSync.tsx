/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { MemoryType } from '@/common/types/memory';
import { MEMORY_CATEGORIES } from '../categories';

/**
 * Applies `?type=<category>` from the URL to the Memory filters: the sidebar's Wiki entry
 * links to `/memory?type=wiki`, and the Archive entry to `/memory`. Renders nothing; it only
 * reports the category when the URL's value changes, so chips and dropdowns stay in charge
 * of the filter in between.
 */
const UrlTypeSync: React.FC<{ onType: (type: MemoryType | null) => void }> = ({ onType }) => {
  const [params] = useSearchParams();
  const raw = params.get('type');
  useEffect(() => {
    const known = MEMORY_CATEGORIES.find((c) => c.type === raw);
    onType(known ? known.type : null);
    // `onType` is a stable callback; the URL value is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);
  return null;
};

export default UrlTypeSync;
