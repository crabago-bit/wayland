/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/renderer/hooks/system/usePwaMode', () => ({ default: () => true }));

import PwaPullToRefresh from '@/renderer/components/layout/PwaPullToRefresh';

const touch = (type: string, target: EventTarget, x: number, y: number, fingers = 1) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y, target };
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : Array.from({ length: fingers }, () => point),
  });
  target.dispatchEvent(event);
};

const pull = (target: EventTarget, from: [number, number], to: [number, number]) => {
  touch('touchstart', target, ...from);
  touch('touchmove', target, ...to);
  touch('touchend', target, ...to);
};

describe('PwaPullToRefresh', () => {
  const reload = vi.fn();
  let originalLocation: Location;

  beforeEach(() => {
    reload.mockReset();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
    document.body.innerHTML = '<div class="layout-content"><header id="top">Header</header></div>';
    render(<PwaPullToRefresh />);
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    document.body.innerHTML = '';
  });

  const header = () => document.getElementById('top') as HTMLElement;

  it('reloads on a deliberate, mostly vertical pull that starts near the top', () => {
    pull(header(), [100, 20], [110, 200]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a short pull', () => {
    pull(header(), [100, 20], [100, 120]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores a pull that starts below the top zone', () => {
    pull(header(), [100, 300], [100, 500]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores a diagonal swipe', () => {
    pull(header(), [10, 20], [200, 180]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores a downward drag inside a scrollable region (e.g. scrolling a chat back)', () => {
    const list = document.createElement('div');
    list.style.overflowY = 'auto';
    Object.defineProperty(list, 'scrollHeight', { value: 2000 });
    Object.defineProperty(list, 'clientHeight', { value: 400 });
    const message = document.createElement('p');
    list.appendChild(message);
    document.querySelector('.layout-content')?.appendChild(list);
    pull(message, [100, 20], [100, 300]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores a two-finger gesture', () => {
    touch('touchstart', header(), 100, 20);
    touch('touchmove', header(), 100, 200, 2);
    touch('touchend', header(), 100, 200);
    expect(reload).not.toHaveBeenCalled();
  });
});
