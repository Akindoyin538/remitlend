"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Lightweight fixed-size list virtualization (windowing).
 *
 * Renders only the rows intersecting the scroll viewport plus a configurable
 * buffer above and below, keeping the DOM node count — and therefore memory and
 * layout cost — flat regardless of how many items are in the list. This mirrors
 * the windowing strategy of `@tanstack/react-virtual`; it is implemented inline
 * to avoid adding a dependency that currently conflicts with the repo's peer
 * ranges.
 *
 * Fallback: callers should still render a paginated, non-windowed list when
 * JavaScript is unavailable (e.g. inside `<noscript>`), because this hook needs
 * scroll events to function.
 */
export interface UseWindowedListOptions {
  /** Total number of items in the backing collection. */
  itemCount: number;
  /** Fixed rendered height of a single row, in pixels. */
  itemHeight: number;
  /** Rows to render outside the viewport on each side. Defaults to 5. */
  overscan?: number;
  /** When set, scrollTop is saved to sessionStorage and restored on mount (back-navigation). */
  storageKey?: string;
}

export interface WindowedRange {
  /** Index of the first row to render (inclusive). */
  startIndex: number;
  /** Index of the last row to render (inclusive). */
  endIndex: number;
  /** Total scrollable height of the list, in pixels. */
  totalHeight: number;
  /** Pixel offset to translate the rendered window by. */
  offsetY: number;
  /** Ref to attach to the scroll container. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Imperatively restore a previously captured scrollTop value. */
  scrollTo: (scrollTop: number) => void;
}

export function useWindowedList({
  itemCount,
  itemHeight,
  overscan = 5,
  storageKey,
}: UseWindowedListOptions): WindowedRange {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const measure = () => setViewportHeight(node.clientHeight);
    measure();

    if (storageKey) {
      try {
        const saved = Number(window.sessionStorage.getItem(`windowed:${storageKey}`));
        if (Number.isFinite(saved) && saved > 0) {
          node.scrollTop = saved;
          setScrollTop(saved);
        }
      } catch {
        // sessionStorage unavailable; start at the top.
      }
    }

    const onScroll = () => {
      setScrollTop(node.scrollTop);
      if (storageKey) {
        try {
          window.sessionStorage.setItem(`windowed:${storageKey}`, String(node.scrollTop));
        } catch {
          // ignore
        }
      }
    };
    node.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    resizeObserver?.observe(node);

    return () => {
      node.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
    };
  }, [storageKey]);

  const scrollTo = useCallback((next: number) => {
    const node = containerRef.current;
    if (node) {
      node.scrollTop = next;
      setScrollTop(next);
    }
  }, []);

  const effectiveViewport = viewportHeight || itemHeight * 10;
  const firstVisible = Math.floor(scrollTop / itemHeight);
  const visibleCount = Math.ceil(effectiveViewport / itemHeight);

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(itemCount - 1, firstVisible + visibleCount + overscan);

  return {
    startIndex,
    endIndex: Math.max(startIndex, endIndex),
    totalHeight: itemCount * itemHeight,
    offsetY: startIndex * itemHeight,
    containerRef,
    scrollTo,
  };
}
