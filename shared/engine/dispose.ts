import { useEffect, useRef } from "react";

type Disposable = { dispose: () => void };

// Frees GPU resources made in a memo once they are truly done with: when the memo makes new ones, or the component
// goes. Not on React's development double mount, which runs every cleanup once and then mounts again with the same
// memo, and would otherwise leave a mesh drawing with freed buffers. Any number of items, and the number may change.
export function useDispose(...items: (Disposable | null | undefined)[]) {
  // A new generation whenever the items are not the same ones as last render.
  const generation = useRef({ items: [] as (Disposable | null | undefined)[], count: 0 });
  const g = generation.current;
  if (g.items.length !== items.length || items.some((item, i) => item !== g.items[i])) {
    g.items = items;
    g.count++;
  }
  const current = g.items;
  const held = useRef<unknown[] | null>(null);
  useEffect(() => {
    held.current = current;
    return () => {
      held.current = null;
      // Freed only if, a moment later, these are not back in use.
      window.setTimeout(() => {
        if (held.current !== current) current.forEach((item) => item?.dispose());
      }, 0);
    };
    // The generation stands for the items.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.count]);
}
