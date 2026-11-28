import type * as THREE from "three/webgpu";
import { lights } from "three/tsl";

// The only lights the forest is lit by: the sun and the sky (outside.tsx fills it in). The scene also holds the headlamp
// and the torches' and lanterns' lights for underground, all at nothing out in the clearing; left to the default, every
// leaf, blade and trunk pixel would loop over all of them.
export const outdoorLights = lights([]);

// The layer that undergrowth past its view distance moves to: the eye no longer draws it, but the sun's shadow camera
// still does, so its shade on the floor never depends on where the eye stood when the shadow was last drawn.
export const SHADOW_ONLY_LAYER = 20;

// Whether the wood is drawn at all (forest/index.tsx hides it deep underground); the cliff's growth (outside.tsx) goes
// with it.
export const woodShown = { current: true };

// Development only: parts of the outdoors by name, so `__burrowHide("ledges")` and the like can take one out of the
// frame to see what it costs (stats.ts's `__burrowStats()` before and after). A name hidden stays hidden until shown.
export const devParts = new Map<string, () => THREE.Object3D[]>();
export const devHidden = new Set<string>();
if (process.env.NODE_ENV !== "production")
  Object.assign(globalThis, {
    __burrowHide: (name?: string, hide = true) => {
      if (!name || !devParts.has(name)) return `parts: ${[...devParts.keys()].join(", ")}`;
      if (hide) devHidden.add(name);
      else devHidden.delete(name);
      return `${name} ${hide ? "hidden" : "shown"}`;
    }
  });

// Puts each part's visibility to what `__burrowHide` asked (called each frame by the forest); true if any changed, so
// the sun's shadow can be drawn again without it.
export function applyDevParts() {
  let changed = false;
  for (const [name, objects] of devParts)
    for (const object of objects()) {
      const visible = !devHidden.has(name);
      if (object.visible === visible) continue;
      object.visible = visible;
      changed = true;
    }
  return changed;
}
