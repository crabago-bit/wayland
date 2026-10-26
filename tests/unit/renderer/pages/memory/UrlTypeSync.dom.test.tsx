import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UrlTypeSync from '@renderer/pages/memory/components/UrlTypeSync';

afterEach(cleanup);

const mount = (url: string) => {
  const onType = vi.fn();
  render(
    <MemoryRouter initialEntries={[url]}>
      <UrlTypeSync onType={onType} />
    </MemoryRouter>
  );
  return onType;
};

describe('UrlTypeSync', () => {
  it('reports the category named in the URL', () => {
    expect(mount('/memory?type=wiki')).toHaveBeenCalledWith('wiki');
    cleanup();
    expect(mount('/memory?type=decision')).toHaveBeenCalledWith('decision');
  });

  it('reports no category for a bare /memory or an unknown value', () => {
    expect(mount('/memory')).toHaveBeenCalledWith(null);
    cleanup();
    expect(mount('/memory?type=bogus')).toHaveBeenCalledWith(null);
  });
});
