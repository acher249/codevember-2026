import type { DayDefinition } from "./engine/types";

// Each day is its own chunk, loaded only when someone opens it.
export const dayLoaders: Record<string, () => Promise<{ default: DayDefinition }>> = {
  "01-fold": () => import("../01-fold"),
  "02-shatter": () => import("../02-shatter"),
  "03-melt": () => import("../03-melt"),
  "04-tangle": () => import("../04-tangle"),
  "05-moss": () => import("../05-moss"),
  "06-orrery": () => import("../06-orrery")
};
