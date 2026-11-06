import { useSyncExternalStore } from "react";

// A day can ask the visitor to do one thing first. It stays up until the day says that they have.
let done = false;
const listeners = new Set<() => void>();

const set = (value: boolean) => {
  if (done === value) return;
  done = value;
  for (const listener of listeners) listener();
};

export const dismissPrompt = () => set(true);
export const resetPrompt = () => set(false);

export const usePromptDone = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => done,
    () => false
  );
