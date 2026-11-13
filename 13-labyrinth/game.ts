import { useSyncExternalStore } from "react";

// Game mode: how many coins you have, kept in this browser between visits, and the last milestone passed and the last
// rabbit caught, for the overlay to celebrate.
const KEY = "codevember-labyrinth-coins";

export type Milestone = { size: 10 | 100; coins: number; at: number };
export type Catch = { caught: number; at: number };
type State = { coins: number; milestone: Milestone | null; bunny: Catch | null; caught: number; on: boolean };

// What a rabbit is worth.
export const BUNNY = 25;

let state: State = { coins: 0, milestone: null, bunny: null, caught: 0, on: false };
let loaded = false;
const listeners = new Set<() => void>();

const current = () => {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    try {
      const kept = Number(window.localStorage.getItem(KEY));
      if (Number.isFinite(kept) && kept > 0) state = { ...state, coins: Math.floor(kept) };
    } catch {
      // A private window: start from nothing.
    }
  }
  return state;
};

const change = (next: Partial<State>) => {
  state = { ...current(), ...next };
  listeners.forEach((listener) => listener());
};

export function useGame() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current,
    () => state
  );
}

// Adds coins, and says which milestone that passed, if any: every fifth is only heard, every tenth and hundredth seen too.
function add(more: number, extra: Partial<State> = {}): 0 | 5 | 10 | 100 {
  const was = current().coins;
  const coins = was + more;
  const past = (every: number) => Math.floor(coins / every) > Math.floor(was / every);
  const size = past(100) ? 100 : past(10) ? 10 : past(5) ? 5 : 0;
  const shown = size === 10 || size === 100;
  change({ ...extra, coins, milestone: shown ? { size, coins: Math.floor(coins / size) * size, at: performance.now() } : current().milestone });
  try {
    window.localStorage.setItem(KEY, String(coins));
  } catch {
    // Not kept beyond this visit, then.
  }
  return size;
}

export const game = {
  get on() {
    return current().on;
  },
  setOn(on: boolean) {
    if (on !== current().on) change({ on, milestone: null, bunny: null });
  },
  collect: () => add(1),
  // A rabbit caught: worth a handful of coins at once.
  catchBunny() {
    const caught = current().caught + 1;
    return add(BUNNY, { caught, bunny: { caught, at: performance.now() } });
  }
};
