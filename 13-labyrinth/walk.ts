import type { Solids } from "../shared/engine/walk";
import { liveHeights, SINK, SIZE } from "./hedge";
import { CELL, HEIGHT, tallness, THICK, WALL_LENGTH } from "./hedge-look";

// One maze period across the ground: the world looks the same moved by this much either way.
export const PERIOD = SIZE * CELL;

const slotOf = (cell: number) => ((cell % SIZE) + SIZE) % SIZE;
const topOf = (h: number, x: number, z: number) => HEIGHT * tallness(x, z) - (1 - h) * SINK;

// The hedges as boxes for walking into, as they stand this frame: each cell's east and south walls, and the post at its
// south-east corner, as tall as the tallest wall that meets it.
export const hedgeSolids: Solids = (x, z, reach, add) => {
  const heights = liveHeights.current;
  if (!heights) return;
  const half = THICK / 2;
  const along = WALL_LENGTH / 2;
  for (let wj = Math.floor((z - reach) / CELL) - 1; wj <= Math.floor((z + reach) / CELL); wj++) {
    for (let wi = Math.floor((x - reach) / CELL) - 1; wi <= Math.floor((x + reach) / CELL); wi++) {
      const i = slotOf(wi);
      const j = slotOf(wj);
      const cell = j * SIZE + i;
      const east = heights[cell * 2];
      const south = heights[cell * 2 + 1];
      const ex = (wi + 1) * CELL;
      const ez = (wj + 0.5) * CELL;
      if (east > 0.002) add(ex - half, ez - along, ex + half, ez + along, topOf(east, ex, ez));
      const sx = (wi + 0.5) * CELL;
      const sz = (wj + 1) * CELL;
      if (south > 0.002) add(sx - along, sz - half, sx + along, sz + half, topOf(south, sx, sz));
      const post = Math.max(east, south, heights[(j * SIZE + slotOf(wi + 1)) * 2 + 1], heights[(slotOf(wj + 1) * SIZE + i) * 2]);
      if (post > 0.002) add(ex - half, sz - half, ex + half, sz + half, topOf(post, ex, sz));
    }
  }
};
