"use client";

import type { ReactNode } from "react";
import { useWindowedList } from "../../hooks/useWindowedList";

interface WindowedListProps<T> {
  items: T[];
  /** Fixed rendered row height in px (including vertical gap). */
  itemHeight: number;
  label: string;
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
  /** Persists scroll position across back-navigation. */
  storageKey?: string;
  overscan?: number;
  className?: string;
}

/**
 * Windowed (virtual) list: renders the visible slice plus a small overscan and
 * announces the full set size via aria-setsize / aria-posinset.
 */
export function WindowedList<T>({
  items,
  itemHeight,
  label,
  getKey,
  renderItem,
  storageKey,
  overscan = 5,
  className = "max-h-[70vh] overflow-y-auto pr-1",
}: WindowedListProps<T>) {
  const { startIndex, endIndex, totalHeight, offsetY, containerRef } = useWindowedList({
    itemCount: items.length,
    itemHeight,
    overscan,
    storageKey,
  });

  return (
    <div ref={containerRef} className={className} role="list" aria-label={label}>
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {items.slice(startIndex, endIndex + 1).map((item, i) => {
            const index = startIndex + i;
            return (
              <div
                key={getKey(item, index)}
                role="listitem"
                aria-setsize={items.length}
                aria-posinset={index + 1}
                style={{ height: itemHeight }}
              >
                {renderItem(item, index)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
