"use client";

import { useSyncExternalStore } from "react";
import type { LoadStep } from "@/shared/ui/Loader";

// The calendar as plain HTML (HubPage.tsx), up from the first paint while the stage builds the 3D calendar behind it: how
// far the stage has got, whether it failed, and whether the plain page is still the one on show. The 3D waits for the
// stage; the page does not.
type Preface = { step: LoadStep; failed: boolean; up: boolean };

const listeners = new Set<() => void>();
let state: Preface = { step: "engine", failed: false, up: false };
const set = (patch: Partial<Preface>) => {
  const next = { ...state, ...patch };
  if (next.step === state.step && next.failed === state.failed && next.up === state.up) return;
  state = next;
  listeners.forEach((listener) => listener());
};

export const prefaceState = () => state;
export const setPrefaceStep = (step: LoadStep) => set({ step });
export const setPrefaceFailed = (failed: boolean) => set({ failed });
export const setPrefaceUp = (up: boolean) => set({ up });

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const SERVER: Preface = { step: "engine", failed: false, up: true };
export const usePreface = () => useSyncExternalStore(subscribe, () => state, () => SERVER);
