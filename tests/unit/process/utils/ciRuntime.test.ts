import { describe, expect, it } from 'vitest';
import { isCiRuntime } from '@process/utils/ciRuntime';

describe('isCiRuntime', () => {
  it('is true for CI=true, CI=1 and GitHub Actions', () => {
    expect(isCiRuntime({ CI: 'true' })).toBe(true);
    expect(isCiRuntime({ CI: '1' })).toBe(true);
    expect(isCiRuntime({ GITHUB_ACTIONS: 'true' })).toBe(true);
  });

  it('is false otherwise', () => {
    expect(isCiRuntime({})).toBe(false);
    expect(isCiRuntime({ CI: 'false' })).toBe(false);
    expect(isCiRuntime({ CI: '0' })).toBe(false);
  });
});
