/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { isAllowedExtraListenAddress, parseExtraListen } from '@process/webserver/index';

describe('WAYLAND_EXTRA_LISTEN allowlist', () => {
  it('accepts loopback and Tailscale CGNAT addresses only', () => {
    expect(isAllowedExtraListenAddress('127.0.0.1')).toBe(true);
    expect(isAllowedExtraListenAddress('::1')).toBe(true);
    expect(isAllowedExtraListenAddress('100.124.56.125')).toBe(true);
    expect(isAllowedExtraListenAddress('100.64.0.1')).toBe(true);
    expect(isAllowedExtraListenAddress('100.127.255.254')).toBe(true);
  });

  it('refuses LAN, public, and malformed addresses', () => {
    expect(isAllowedExtraListenAddress('192.168.1.10')).toBe(false);
    expect(isAllowedExtraListenAddress('10.0.0.5')).toBe(false);
    expect(isAllowedExtraListenAddress('100.128.0.1')).toBe(false);
    expect(isAllowedExtraListenAddress('100.63.255.255')).toBe(false);
    expect(isAllowedExtraListenAddress('0.0.0.0')).toBe(false);
    expect(isAllowedExtraListenAddress('2.24.65.182')).toBe(false);
    expect(isAllowedExtraListenAddress('')).toBe(false);
    expect(isAllowedExtraListenAddress('not-an-ip')).toBe(false);
  });

  it('parses a comma list into allowed and refused buckets', () => {
    const parsed = parseExtraListen(' 100.124.56.125, 0.0.0.0 ,, 192.168.0.2 ');
    expect(parsed.allowed).toEqual(['100.124.56.125']);
    expect(parsed.refused).toEqual(['0.0.0.0', '192.168.0.2']);
    expect(parseExtraListen(undefined)).toEqual({ allowed: [], refused: [] });
  });
});
