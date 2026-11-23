import type { DayDefinition } from "./engine/types";

// Each day is its own chunk, loaded only when someone opens it.
export const dayLoaders: Record<string, () => Promise<{ default: DayDefinition }>> = {
  "01-fold": () => import("../01-fold"),
  "02-shatter": () => import("../02-shatter"),
  "03-melt": () => import("../03-melt"),
  "04-tangle": () => import("../04-tangle"),
  "05-moss": () => import("../05-moss"),
  "06-orrery": () => import("../06-orrery"),
  "07-hollow": () => import("../07-hollow"),
  "08-tesseract": () => import("../08-tesseract"),
  "09-membrane": () => import("../09-membrane"),
  "10-caustic": () => import("../10-caustic"),
  "11-rust": () => import("../11-rust"),
  "12-feather": () => import("../12-feather"),
  "13-labyrinth": () => import("../13-labyrinth"),
  "14-tension": () => import("../14-tension"),
  "15-mirage": () => import("../15-mirage"),
  "16-spore": () => import("../16-spore"),
  "17-kelp": () => import("../17-kelp"),
  "18-pendulum": () => import("../18-pendulum"),
  "19-erosion": () => import("../19-erosion"),
  "20-cocoon": () => import("../20-cocoon"),
  "21-bolt": () => import("../21-bolt"),
  "22-echo": () => import("../22-echo"),
  "23-magma": () => import("../23-magma")
};
