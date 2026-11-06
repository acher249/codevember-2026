"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { SettingsSchema, SettingValue } from "./types";

// One day's settings. The panel writes here; scenes read with useSetting (re-renders) or useSettingRef (per-frame).
export class SettingsStore {
  private values = new Map<string, SettingValue>();
  private listeners = new Set<() => void>();
  private actions = new Map<string, Set<() => void>>();

  constructor(readonly schema: SettingsSchema) {
    this.reset();
  }

  reset() {
    for (const [key, setting] of Object.entries(this.schema)) {
      if (setting.type !== "action") this.values.set(key, setting.value);
    }
    this.listeners.forEach((listener) => listener());
  }

  get(key: string) {
    return this.values.get(key);
  }

  set(key: string, value: SettingValue) {
    this.values.set(key, value);
    this.listeners.forEach((listener) => listener());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  trigger(key: string) {
    this.actions.get(key)?.forEach((action) => action());
  }

  onAction(key: string, action: () => void) {
    const set = this.actions.get(key) ?? new Set();
    this.actions.set(key, set);
    set.add(action);
    return () => {
      set.delete(action);
    };
  }
}

const SettingsContext = createContext<SettingsStore>(new SettingsStore({}));
export const SettingsProvider = SettingsContext.Provider;

export function useCreateSettings(schema: SettingsSchema | undefined) {
  return useMemo(() => new SettingsStore(schema ?? {}), [schema]);
}

export function useSettingsStore() {
  return useContext(SettingsContext);
}

export function useSetting<T extends SettingValue>(key: string) {
  const store = useContext(SettingsContext);
  return useSyncExternalStore(store.subscribe, () => store.get(key)) as T;
}

// For useFrame: always current, never re-renders the scene.
export function useSettingRef<T extends SettingValue>(key: string) {
  const store = useContext(SettingsContext);
  const ref = useRef(store.get(key) as T);
  useEffect(() => {
    const sync = () => {
      ref.current = store.get(key) as T;
    };
    sync();
    return store.subscribe(sync);
  }, [store, key]);
  return ref;
}

export function useSettingAction(key: string, action: () => void) {
  const store = useContext(SettingsContext);
  const latest = useRef(action);
  latest.current = action;
  useEffect(() => store.onAction(key, () => latest.current()), [store, key]);
}
