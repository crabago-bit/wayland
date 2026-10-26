/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import type React from 'react';

export type PanZoomView = { x: number; y: number; k: number };
const FIT: PanZoomView = { x: 0, y: 0, k: 1 };

/** Drag to pan and wheel to zoom an SVG group; `moved()` tells a click from the end of a drag. */
export function usePanZoom() {
  const [view, setView] = useState<PanZoomView>(FIT);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => ({ ...v, k: Math.min(6, Math.max(0.5, v.k * factor)) }));
  }, []);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) {
      d.x = e.clientX;
      d.y = e.clientY;
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  }, []);
  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);
  const reset = useCallback(() => setView(FIT), []);
  const moved = useCallback(() => Boolean(drag.current?.moved), []);

  return {
    view,
    reset,
    moved,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp, onPointerLeave: onPointerUp },
    transform: `translate(${view.x} ${view.y}) scale(${view.k})`,
  };
}
