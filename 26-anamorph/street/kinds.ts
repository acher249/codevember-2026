import * as THREE from "three/webgpu";
import { buildPit, buildPool, type Drawing, type Scans } from "./drawings";
import * as lava from "./drawings/lava";
import * as ocean from "./drawings/ocean";
import * as subway from "./drawings/subway";
import * as crystal from "./drawings/crystal";

// Every drawing there is, by the name used in the address (?v=): what it is, the textures it loads for itself, and how
// it is built. Each new one lives in its own file under ./drawings/.
export type Kind = { name: string; textures: Record<string, { url: string; colour?: boolean }>; build: (scans: Scans, extra: Record<string, THREE.Texture>) => Drawing };

export const KINDS = {
  pit: { name: "a pit", textures: {}, build: (scans) => buildPit(scans) },
  pool: { name: "a swimming pool", textures: {}, build: (scans) => buildPool(scans) },
  lava: { name: "a lava crack", textures: lava.textures, build: lava.build },
  ocean: { name: "a window into the sea", textures: ocean.textures, build: ocean.build },
  subway: { name: "a subway tunnel", textures: subway.textures, build: subway.build },
  crystal: { name: "a crystal cave", textures: crystal.textures, build: crystal.build },
} satisfies Record<string, Kind>;

export type DrawingKind = keyof typeof KINDS;
