import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

import TopbarChips from '@renderer/pages/memory/components/TopbarChips';

const counts = { decision: 18, pattern: 111, observation: 12638, session: 717, wiki: 129, preference: 0 };

afterEach(cleanup);

describe('TopbarChips with overlapping brain counts', () => {
  it('shows the supplied total instead of summing overlapping types', () => {
    render(<TopbarChips typeCounts={counts} activeType={null} onFilterChange={() => {}} total={13484} />);
    expect(screen.getByTestId('topbar-chip-memories').textContent).toContain('13,484');
    expect(screen.getByTestId('topbar-chip-decisions').textContent).toContain('18');
    expect(screen.getByTestId('topbar-chip-wiki').textContent).toContain('129');
  });

  it('explains each chip via its title when descriptions are given', () => {
    render(
      <TopbarChips
        typeCounts={counts}
        activeType={null}
        onFilterChange={() => {}}
        total={13484}
        descriptions={{ memories: 'all of it', decisions: 'semantic', wiki: 'long-term' }}
      />
    );
    expect(screen.getByTestId('topbar-chip-wiki').getAttribute('title')).toBe('long-term');
    expect(screen.getByTestId('topbar-chip-memories').getAttribute('title')).toBe('all of it');
  });

  it('keeps the old summed total and no titles without the new props', () => {
    render(<TopbarChips typeCounts={{ ...counts, wiki: 0 }} activeType={null} onFilterChange={() => {}} />);
    expect(screen.getByTestId('topbar-chip-memories').textContent).toContain('13,484');
    expect(screen.getByTestId('topbar-chip-wiki').getAttribute('title')).toBeNull();
  });
});
