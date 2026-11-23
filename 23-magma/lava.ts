// The lava, worked out on the processor each frame: a depth and a temperature in each cell of a grid over the plate (a
// thin-film flow, as geologists model a lava flow). Each step, lava moves from a cell to each neighbour by how much higher
// its surface stands, times its depth cubed and its fluidity (a viscous film's flow), and the fluidity falls steeply as it
// cools: so it runs hot and fast out of the bite, slows as it spreads, and stalls in a crusted lobe at its cool front,
// until hot lava behind breaks out past it. Heat travels with the lava, and is lost from its top, faster where it is thin.
// The pocket's pastry walls hold the filling in, except where bitten away. The plate scorches wherever hot lava lies.
//
// Small enough (160 × 160, only the part with lava in it) to step four times a frame in about a millisecond, and its
// state goes to the graphics card as two small textures.

// sample() gives a point's floor and lava (y, depth, heat, char) and the surface as drawn. The base texture's w holds
// the headroom under the pastry's roof.

import * as THREE from "three/webgpu";
import { bitten, type Bite, bottomHeight, CRUST, outline, PLATE, plateHeight, pocketToWorld, SHELL, topHeight, toPocket } from "./shape";

export const N = 256;
// The grid spans the plate: from -SPAN to SPAN in x and z.
export const SPAN = 0.48;
const DX = (2 * SPAN) / N;

// How readily hot lava flows (in these units), how fast its fluidity falls with cooling, and how fast it loses heat.
const FLOW = 4200;
const STIFFEN = 8.5;
// Slow enough that the flow stays molten a while, a skin forming first at its thin, cool edges.
const COOL = 0.05;
const COOL_COVERED = 0.0015;
// Depth (units) below which a cell counts as dry.
const DRY = 0.0006;
// How full the pocket starts: its filling's top stands this high.
const FILL = 0.05;
// Substeps per step: four, or two on a light device (lava.light), half the work for a flow a little less smooth.
const STEPS = 4;
// Fluidity by temperature (FLOW × e^(STIFFEN (t − 1))), tabled in 1024 steps: an exponential per cell per step was
// most of the flow's cost.
const FLUID = new Float32Array(1026).map((_, n) => FLOW * Math.exp(STIFFEN * (Math.min(n, 1024) / 1024 - 1)));
const TILE_BITS = 4;
const TILE = 1 << TILE_BITS;
const TILES = 256 >> TILE_BITS;
// How deep a bitten roll's filling may stand where it comes out (about 1.5 mm), and no deeper.
const POUR_HEAD = 0.006;

export type Lava = ReturnType<typeof createLava>;

export function createLava() {
  const cells = N * N;
  const base = new Float32Array(cells);
  const depth = new Float32Array(cells);
  const heat = new Float32Array(cells);
  const energy = new Float32Array(cells);
  const vx = new Float32Array(cells);
  const vz = new Float32Array(cells);
  const char = new Float32Array(cells);
  // What the pocket is at each cell: 0 open plate, 1 inside it (the filling's cavity), 2 its sealed pastry edge.
  const kind = new Uint8Array(cells);
  // Where the plate ends: off the edge of it.
  const off = new Uint8Array(cells);
  const solid = new Uint8Array(cells);
  // Inside the pocket, how high the filling may stand: just under the pastry's roof.
  const roof = new Float32Array(cells);
  // Inside the pocket but under a bite, so open to the air; and the hot open cells, for steam to rise from.
  const opened = new Uint8Array(cells);
  // Cells of the pocket's footprint within 6 mm of a bite, set when bitten: the audit's test, so it costs nothing per move.
  const mouth = new Uint8Array(cells);
  const hot: number[] = [];
  // The plate's own height under each cell, kept for when a bitten edge's floor is put back.
  const plate = new Float32Array(cells);
  const seen = new Float32Array(cells);
  const blur = new Float32Array(cells);
  // Heat carried by the shown depth, softened alongside it.
  const warm = new Float32Array(cells);
  const warmBlur = new Float32Array(cells);
  // The cells the display is kept up to date over (see step()).
  const shown = { i0: N, j0: N, i1: -1, j1: -1 };
  let lowest = Infinity;
  let frame = 0;
  const fx = new Float32Array(cells);
  const fz = new Float32Array(cells);
  const flu = new Float32Array(cells);
  // The flow's working set: tiles of TILE × TILE cells, which are wet, which are worked, and their cells.
  const wetTile = new Uint8Array(TILES * TILES);
  const activeTile = new Uint8Array(TILES * TILES);
  const cellList = new Int32Array(cells);
  // Whether a roll has poured since the last reset (the flow runs from then, as from a bite).
  let poured = false;

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const [x, z] = centre(i, j);
      const r = Math.hypot(x, z);
      base[k] = plateHeight(r);
      plate[k] = base[k];
      off[k] = r > PLATE - 0.012 ? 1 : 0;
      const [px, pz] = toPocket(x, z);
      const d = -outline(px, pz);
      const roofLocal = d > 0 ? topHeight(d, px, pz) - CRUST * 1.6 : 0;
      kind[k] = d > 0.03 && roofLocal > 0.03 ? 1 : d > -0.004 ? 2 : 0;
      if (kind[k] === 1) {
        // Inside the tilted pocket the filling lies on the bread over its bottom crust, and under its roof, both in the
        // world: lower toward the bitten end, so it runs downhill out of the bite.
        base[k] = pocketToWorld(px, bottomHeight(d) + SHELL, pz)[1];
        roof[k] = pocketToWorld(px, roofLocal, pz)[1];
        lowest = Math.min(lowest, base[k]);
      }
    }
  }

  // The textures: depth, temperature and flow for the lava's mesh (exact per cell); the plate's scorch (smoothed).
  const state = new Float32Array(cells * 4);
  const stateTexture = new THREE.DataTexture(state, N, N, THREE.RGBAFormat, THREE.FloatType);
  stateTexture.magFilter = stateTexture.minFilter = THREE.NearestFilter;
  // Where each cell's floor is (the plate, or inside the pocket its bread): set once.
  const floor = new Float32Array(cells * 4);
  // z: inside the pocket (its filling: sauce, cheese, bits), for the lava's shading to tell from what has run out.
  for (let k = 0; k < cells; k++) {
    floor[k * 4] = base[k];
    floor[k * 4 + 2] = kind[k] === 1 ? 1 : 0;
    floor[k * 4 + 3] = 1;
  }
  const baseTexture = new THREE.DataTexture(floor, N, N, THREE.RGBAFormat, THREE.FloatType);
  baseTexture.magFilter = baseTexture.minFilter = THREE.NearestFilter;
  // The surface as drawn, worked out once per cell per step (floor plus shownRaise), and whether the cell is inside the
  // pocket: the mesh reads its height and slope from this alone, a quarter of the reads it took from depth and floor.
  const surface = new Float32Array(cells * 2);
  const surfaceTexture = new THREE.DataTexture(surface, N, N, THREE.RGFormat, THREE.FloatType);
  surfaceTexture.magFilter = surfaceTexture.minFilter = THREE.NearestFilter;
  baseTexture.needsUpdate = true;
  const scorch = new Uint8Array(cells * 4);
  const scorchTexture = new THREE.DataTexture(scorch, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  scorchTexture.magFilter = scorchTexture.minFilter = THREE.LinearFilter;

  const lava = {
    base,
    depth,
    heat,
    char,
    stateTexture,
    scorchTexture,
    baseTexture,
    surfaceTexture,
    bites: [] as Bite[],
    // Lava still to come up from inside the pocket, after a bite (a pocket holds more than it looks).
    budget: 0,
    // Lava running out of bitten pizza rolls: each a small hot source on the open plate, at x, z, over radius r, with
    // volume left to give at a rate per second.
    pours: [] as { x: number; z: number; r: number; left: number; rate: number }[],
    // A phone or the Low tier: the flow takes two substeps a step, not four.
    light: false,
    // For the light, the sound and the steam: where the hot lava is, how much of it, and how much is moving.
    glow: { x: 0, z: 0, y: 0, amount: 0, flowing: 0, inside: 0, level: 0 },
    // How many times lava crossed out of the pocket's footprint through the bite, and anywhere else (must stay 0).
    audit: { bitePours: 0, leaks: 0 },
    reset,
    bite,
    pour,
    step,
    sample,
    hotCell,
    stats
  };
  reset();
  return lava;

  function centre(i: number, j: number): [number, number] {
    return [-SPAN + (i + 0.5) * DX, -SPAN + (j + 0.5) * DX];
  }

  function walls() {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        let wall = off[k] === 1 || kind[k] === 2;
        opened[k] = 0;
        mouth[k] = 0;
        if (kind[k] !== 0 && lava.bites.length) {
          const [x, z] = centre(i, j);
          const [px, pz] = toPocket(x, z);
          const d = bitten(lava.bites, px, pz);
          mouth[k] = d < 0.006 ? 1 : 0;
          if (wall && kind[k] === 2 && d < 0.004) {
            wall = false;
            // Bitten through the pastry's edge: the filling runs out over what is left of its bottom crust, so the
            // floor there is the pocket's underside, meeting the cavity's floor inside and the plate at the rim; not
            // the plate (a cliff the filling would hang down in a jagged curtain).
            const depthIn = Math.max(0, -outline(px, pz));
            base[k] = Math.max(plate[k], pocketToWorld(px, bottomHeight(depthIn), pz)[1]);
          }
          if (kind[k] === 1 && d < 0) opened[k] = 1;
          // Just past a bite's edge, still under pastry: drawn too (the shader cuts the filling at the bite's own arc),
          // so its surface runs on unbroken to that arc instead of dropping to nothing at the next cell.
          else if (kind[k] === 1 && d < 0.02) opened[k] = 2;
        }
        if (wall && kind[k] === 2) base[k] = plate[k];
        solid[k] = wall ? 1 : 0;
        floor[k * 4] = base[k];
        // The mesh is told which cells are pastry wall, so it never stretches a skin of lava across one (the filling
        // inside drawn down to the plate outside, as if it ran out of the pocket's underside).
        floor[k * 4 + 1] = solid[k];
        // w: the headroom under the pastry's roof, which caps how high the surface is raised there; none where the
        // roof is bitten away (or never was), so the filling in a bite rises and bulges exactly as the lava outside.
        floor[k * 4 + 3] = kind[k] === 1 ? Math.max(0, roof[k] - base[k] + (opened[k] === 1 ? 0.006 : 0)) : 1;
      }
    }
    baseTexture.needsUpdate = true;
  }

  function reset() {
    lava.bites.length = 0;
    lava.budget = 0;
    lava.pours.length = 0;
    poured = false;
    activeTile.fill(0);
    fx.fill(0);
    fz.fill(0);
    depth.fill(0);
    heat.fill(0);
    vx.fill(0);
    vz.fill(0);
    char.fill(0);
    shown.i0 = shown.j0 = N;
    shown.i1 = shown.j1 = -1;
    for (let k = 0; k < cells; k++) {
      if (kind[k] === 1) {
        depth[k] = Math.max(0, Math.min(lowest + FILL, roof[k]) - base[k]);
        heat[k] = 1;
      }
    }
    walls();
    upload(true);
  }

  // A bite: the pastry there is gone, so the filling can run out; and a little more comes up behind it.
  function bite(b: Bite) {
    lava.bites.push(b);
    walls();
    // Whatever is opened up inside the bite loses its pastry roof and starts to cool.
    lava.budget += lava.bites.length === 1 ? 0.01 : 0.008;
  }

  // A bitten roll's filling: poured onto the open plate where it lies. Nothing pours onto the pocket, the rim or off the
  // plate.
  // A roll lying on the rim's slope, on the pocket or on another roll has no flat plate under its mouth: the filling
  // comes out at the nearest flat plate toward the middle instead (otherwise it simply never showed).
  function pour(x: number, z: number, volume: number, rate: number, r: number) {
    if (!(volume > 0) || !(rate > 0)) return;
    const reach = Math.hypot(x, z);
    for (let back = 0; back <= 0.2; back += 0.01) {
      const f = reach > 1e-6 ? Math.max(0, reach - back) / reach : 0;
      const p = { x: x * f, z: z * f, r };
      let count = 0;
      pourCells(p, () => count++);
      if (count > 6) {
        x = p.x;
        z = p.z;
        break;
      }
    }
    lava.pours.push({ x, z, r, left: volume, rate });
    poured = true;
  }

  // The cells a pour feeds: open plate within its radius.
  function pourCells(p: { x: number; z: number; r: number }, each: (k: number) => void) {
    const reach = Math.ceil(p.r / DX);
    const ci = Math.floor((p.x + SPAN) / DX);
    const cj = Math.floor((p.z + SPAN) / DX);
    for (let j = Math.max(2, cj - reach); j <= Math.min(N - 3, cj + reach); j++)
      for (let i = Math.max(2, ci - reach); i <= Math.min(N - 3, ci + reach); i++) {
        const k = j * N + i;
        const [x, z] = centre(i, j);
        // Only on the plate's flat floor: poured up on the rim's slope it ran over the edge and through the plate's wall.
        if (kind[k] === 0 && !solid[k] && plate[k] < 0.003 && Math.hypot(x - p.x, z - p.z) <= p.r) each(k);
      }
  }

  function step(dt: number) {
    // A frame with no time in it (the first, or a repeated timestamp) moves nothing, and a long one is cut short: the
    // flow divides by the step, so a zero step would be infinite flow and NaN everywhere after.
    if (!(dt > 1e-5)) return;
    dt = Math.min(dt, 1 / 30);
    const steps = lava.light ? 2 : STEPS;
    const sdt = dt / steps;
    // Nothing runs until something is opened: the sealed pocket's filling just sits there.
    if (!lava.bites.length && !poured) return;
    // Only the rows and columns with lava, and a margin for it to spread into (for the glow and the display); and the
    // tiles of 16 × 16 cells with lava in them or beside them, the only cells the flow is worked over. Scattered pools
    // (a bitten roll's here, the pocket's there) cost their own tiles, not the whole box round them.
    let i0 = N,
      i1 = 0,
      j0 = N,
      j1 = 0;
    wetTile.fill(0);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (depth[j * N + i] > DRY) {
          if (i < i0) i0 = i;
          if (i > i1) i1 = i;
          if (j < j0) j0 = j;
          if (j > j1) j1 = j;
          wetTile[(j >> TILE_BITS) * TILES + (i >> TILE_BITS)] = 1;
        }
      }
    }
    // A pour about to start counts as lava already there.
    for (const p of lava.pours) {
      const ci = Math.floor((p.x + SPAN) / DX);
      const cj = Math.floor((p.z + SPAN) / DX);
      const reach = Math.ceil(p.r / DX);
      i0 = Math.min(i0, ci - reach);
      i1 = Math.max(i1, ci + reach);
      j0 = Math.min(j0, cj - reach);
      j1 = Math.max(j1, cj + reach);
      wetTile[(Math.max(0, Math.min(N - 1, cj)) >> TILE_BITS) * TILES + (Math.max(0, Math.min(N - 1, ci)) >> TILE_BITS)] = 1;
    }
    if (i1 < i0) return;
    // The active tiles (wet, or next to wet), and their cells; a tile that has just gone quiet has its flows cleared,
    // since cells beside it read them.
    let cellCount = 0;
    for (let tj = 0; tj < TILES; tj++)
      for (let ti = 0; ti < TILES; ti++) {
        let on = 0;
        for (let dj = -1; dj <= 1 && !on; dj++)
          for (let di = -1; di <= 1 && !on; di++) {
            const a = ti + di;
            const b = tj + dj;
            if (a >= 0 && b >= 0 && a < TILES && b < TILES && wetTile[b * TILES + a]) on = 1;
          }
        const t = tj * TILES + ti;
        const ia = Math.max(1, ti << TILE_BITS);
        const ib = Math.min(N - 2, (ti << TILE_BITS) + TILE - 1);
        const ja = Math.max(1, tj << TILE_BITS);
        const jb = Math.min(N - 2, (tj << TILE_BITS) + TILE - 1);
        if (!on && activeTile[t]) {
          for (let j = ja; j <= jb; j++)
            for (let i = ia; i <= ib; i++) {
              fx[j * N + i] = 0;
              fz[j * N + i] = 0;
            }
        }
        activeTile[t] = on;
        if (!on) continue;
        for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) cellList[cellCount++] = j * N + i;
      }
    i0 = Math.max(1, i0 - 2);
    j0 = Math.max(1, j0 - 2);
    i1 = Math.min(N - 2, i1 + 2);
    j1 = Math.min(N - 2, j1 + 2);
    const limit = 1 / 5;

    for (let s = 0; s < steps; s++) {
      // More filling comes up from inside the pocket while there is any to come, hot: only into the cavity still under
      // its roof, and only as far as the roof (a pressure-limited source, not a fixed volume). Poured into the bite it
      // stacked up there faster than it could flow away, standing as a dome above the pastry; now the bite is fed only
      // by the cavity's head pushing out, and the budget waits while the cavity is full.
      if (lava.budget > 0) {
        let room = 0;
        let open = 0;
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const k = j * N + i;
            if (kind[k] !== 1 || opened[k] === 1) continue;
            const r = roof[k] - base[k] - depth[k];
            if (r > 0.0005) {
              room += r;
              open++;
            }
          }
        if (open > 0) {
          const add = Math.min(lava.budget, 0.0016 * sdt, room * DX * DX * 0.5);
          lava.budget -= add;
          const each = add / open / (DX * DX);
          for (let j = j0; j <= j1; j++)
            for (let i = i0; i <= i1; i++) {
              const k = j * N + i;
              if (kind[k] !== 1 || opened[k] === 1 || roof[k] - base[k] - depth[k] <= 0.0005) continue;
              const put = Math.min(each, roof[k] - base[k] - depth[k]);
              heat[k] = (heat[k] * depth[k] + put) / (depth[k] + put);
              depth[k] += put;
            }
        }
      }
      // The rolls' pours: hot filling let out over each one's cells at its rate, but only up to a low head (as the
      // pocket's cavity feeds its bite): poured in faster than it ran away, it stood up in a tall spike. What does not
      // fit waits; a pour with no plate under it is dropped.
      for (let n = lava.pours.length - 1; n >= 0; n--) {
        const p = lava.pours[n];
        let room = 0;
        let count = 0;
        pourCells(p, (k) => {
          count++;
          room += Math.max(0, POUR_HEAD - depth[k]);
        });
        if (!count) p.left = 0;
        const add = Math.min(p.left, p.rate * sdt, room * DX * DX);
        if (add > 0) {
          p.left -= add;
          const share = add / (room * DX * DX);
          pourCells(p, (k) => {
            const put = Math.max(0, POUR_HEAD - depth[k]) * share;
            if (put <= 0) return;
            heat[k] = (heat[k] * depth[k] + put) / (depth[k] + put);
            depth[k] += put;
          });
        }
        if (p.left <= 1e-9) lava.pours.splice(n, 1);
      }
      // Over the active tiles' cells only (see above); each pass is per cell, or adds into neighbours, so order is free.
      for (let c = 0; c < cellCount; c++) {
        const k = cellList[c];
        energy[k] = depth[k] * heat[k];
        // How runny the lava here is, worked out once per cell rather than for each of its edges.
        flu[k] = depth[k] > DRY * 0.25 ? FLUID[(heat[k] * 1024) | 0] : 0;
      }
      // Between each cell and the one to its +x, and the one to its +z: how much moves, never more than evens them.
      for (let c = 0; c < cellCount; c++) {
        const k = cellList[c];
        fx[k] = 0;
        fz[k] = 0;
        if (solid[k]) continue;
        const hk = depth[k];
        const sk = base[k] + hk;
        for (let side = 0; side < 2; side++) {
          const n = side === 0 ? k + 1 : k + N;
          if (solid[n]) continue;
          const hn = depth[n];
          // Dry both sides: nothing to move.
          if (hk <= DRY * 0.25 && hn <= DRY * 0.25) continue;
          const diff = sk - (base[n] + hn);
          // Upwind: the deeper side of the slope carries.
          const from = diff > 0 ? k : n;
          const h = diff > 0 ? hk : hn;
          if (h <= DRY * 0.25) continue;
          let move = flu[from] * h * h * h * diff * (sdt / (DX * DX));
          const most = Math.min(Math.abs(diff) * limit, h * 0.24);
          if (move > most) move = most;
          else if (move < -most) move = -most;
          // Audit: lava may only cross between the pocket's footprint and the open plate through the bite.
          if (move !== 0 && (kind[k] !== 0) !== (kind[n] !== 0)) {
            const inner = kind[k] !== 0 ? k : n;
            if (mouth[inner]) lava.audit.bitePours++;
            else lava.audit.leaks++;
          }
          if (side === 0) fx[k] = move;
          else fz[k] = move;
        }
      }
      for (let c = 0; c < cellCount; c++) {
        const k = cellList[c];
        const mx = fx[k];
        const mz = fz[k];
        if (mx !== 0) {
          const t = heat[mx > 0 ? k : k + 1];
          depth[k] -= mx;
          depth[k + 1] += mx;
          energy[k] -= mx * t;
          energy[k + 1] += mx * t;
        }
        if (mz !== 0) {
          const t = heat[mz > 0 ? k : k + N];
          depth[k] -= mz;
          depth[k + N] += mz;
          energy[k] -= mz * t;
          energy[k + N] += mz * t;
        }
      }
      for (let c = 0; c < cellCount; c++) {
        const k = cellList[c];
        const h = depth[k];
        if (h <= 1e-7) {
          depth[k] = 0;
          heat[k] = 0;
          continue;
        }
        let t = Math.max(0, energy[k] / h);
        // Losing heat from the top, faster where thin; barely at all under the pastry.
        const covered = kind[k] === 1 && opened[k] !== 1;
        const rate = covered ? COOL_COVERED : COOL / (h / 0.012 + 0.35);
        t -= rate * t * sdt;
        heat[k] = Math.min(1, t);
        // Never up through the pastry's roof.
        if (covered && base[k] + h > roof[k]) depth[k] = Math.max(0, roof[k] - base[k]);
        // The flow through the cell, for the crust's wrinkles to follow, smoothed.
        const ux = (fx[k - 1] + fx[k]) * 0.5;
        const uz = (fz[k - N] + fz[k]) * 0.5;
        const scale = DX / Math.max(h, 0.004) / Math.max(sdt, 1e-5);
        vx[k] += (ux * scale - vx[k]) * 0.04;
        vz[k] += (uz * scale - vz[k]) * 0.04;
      }
    }

    // The plate scorches under hot lava, and a little round it.
    const g = lava.glow;
    let sx = 0,
      sz = 0,
      sy = 0,
      sw = 0,
      moving = 0,
      inside = 0;
    hot.length = 0;
    let levelSum = 0,
      levelCount = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        const h = depth[k];
        if (h <= DRY) continue;
        const t = heat[k];
        // Only the open plate scorches: under the pocket (its walls too) the plate is never seen to.
        if (kind[k] === 0) {
          const burn = dt * 0.16 * smooth(0.2, 0.75, t);
          char[k] = Math.min(1, char[k] + burn);
          char[k - 1] = Math.min(1, char[k - 1] + burn * 0.25);
          char[k + 1] = Math.min(1, char[k + 1] + burn * 0.25);
          char[k - N] = Math.min(1, char[k - N] + burn * 0.25);
          char[k + N] = Math.min(1, char[k + N] + burn * 0.25);
        }
        const open = kind[k] !== 1 || opened[k] === 1;
        if (kind[k] === 1 && h > 0.002) {
          levelSum += base[k] + h;
          levelCount++;
        }
        if (!open) {
          inside += h * t;
          continue;
        }
        const w = h * Math.pow(t, 4);
        const [x, z] = centre(i, j);
        sx += x * w;
        sz += z * w;
        sy += (base[k] + h) * w;
        sw += w;
        moving += Math.min(1, Math.hypot(vx[k], vz[k]) * 10) * h * t;
        if (h > 0.003 && t > 0.35 && hot.length < 512) hot.push(k);
      }
    }
    g.amount = Number.isFinite(sw) ? sw * DX * DX * 4000 : 0;
    if (sw > 0) {
      g.x = sx / sw;
      g.z = sz / sw;
      g.y = sy / sw;
    }
    g.flowing = Number.isFinite(moving) ? moving * DX * DX * 4000 : 0;
    g.inside = Number.isFinite(inside) ? inside * DX * DX * 400 : 0;
    // The filling's surface inside the pocket (world height), for the cut walls.
    g.level = levelCount ? levelSum / levelCount : 0;
    // The display is only redone over the area the lava has reached (with room for the softening to spread), which only
    // grows until the next reset: cells outside it are dry and unchanged.
    shown.i0 = Math.min(shown.i0, Math.max(1, i0 - 6));
    shown.j0 = Math.min(shown.j0, Math.max(1, j0 - 6));
    shown.i1 = Math.max(shown.i1, Math.min(N - 2, i1 + 6));
    shown.j1 = Math.max(shown.j1, Math.min(N - 2, j1 + 6));
    upload(false);
  }

  function upload(all: boolean) {
    const a0 = all ? 1 : shown.i0,
      a1 = all ? N - 2 : shown.i1,
      b0 = all ? 1 : shown.j0,
      b1 = all ? N - 2 : shown.j1;
    if (a1 < a0 || b1 < b0) return;
    // Only finite numbers ever reach the graphics card: one NaN, drawn and bloomed, whites out the whole frame. A cell
    // that has gone bad is reset to dry, here and in the flow.
    for (let j = b0 - 2; j <= b1 + 2; j++)
      for (let i = a0 - 2; i <= a1 + 2; i++) {
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const k = j * N + i;
        if (!Number.isFinite(depth[k]) || !Number.isFinite(heat[k]) || !Number.isFinite(vx[k]) || !Number.isFinite(vz[k])) {
          depth[k] = heat[k] = vx[k] = vz[k] = 0;
        }
        // The mesh is only sent lava that can be seen: none under the pastry (only through a bite) or in its walls, so
        // the grid there folds away and costs no shading.
        seen[k] = solid[k] || (kind[k] === 1 && !opened[k]) ? 0 : depth[k];
        warm[k] = seen[k] * heat[k];
        state[k * 4 + 2] = Math.max(-2, Math.min(2, vx[k]));
        state[k * 4 + 3] = Math.max(-2, Math.min(2, vz[k]));
      }
    // Then softened (1-2-1 each way, twice: about two cells each side), so a lobe's edge tapers over a few cells into a
    // rounded lip instead of standing as a one-cell step whose steep triangles show as a saw-tooth at its base.
    for (let pass = 0; pass < 2; pass++) {
      for (let j = b0 - 1; j <= b1 + 1; j++) {
        for (let i = a0; i <= a1; i++) {
          const k = j * N + i;
          blur[k] = (seen[k - 1] + 2 * seen[k] + seen[k + 1]) * 0.25;
          warmBlur[k] = (warm[k - 1] + 2 * warm[k] + warm[k + 1]) * 0.25;
        }
      }
      for (let j = b0; j <= b1; j++) {
        for (let i = a0; i <= a1; i++) {
          const k = j * N + i;
          seen[k] = (blur[k - N] + 2 * blur[k] + blur[k + N]) * 0.25;
          warm[k] = (warmBlur[k - N] + 2 * warmBlur[k] + warmBlur[k + N]) * 0.25;
        }
      }
    }
    // The heat as shown: the depth-weighted average round each cell, so it varies smoothly along a front instead of
    // cell by cell (thin edge cells cool at their own rates, and up the lip's wall that drew stripes a cell apart).
    for (let j = b0; j <= b1; j++)
      for (let i = a0; i <= a1; i++) {
        const k = j * N + i;
        state[k * 4] = seen[k];
        state[k * 4 + 1] = seen[k] > 1e-6 ? Math.min(1, warm[k] / seen[k]) : heat[k];
        surface[k * 2] = floor[k * 4] + shownRaise(seen[k], floor[k * 4 + 3]);
        surface[k * 2 + 1] = floor[k * 4 + 2];
      }
    surfaceTexture.needsUpdate = true;
    stateTexture.needsUpdate = true;
    // The scorch changes slowly: every few frames is plenty.
    if (all || frame++ % 4 === 0) {
      for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) scorch[(j * N + i) * 4] = Math.round(char[j * N + i] * 255);
      scorchTexture.needsUpdate = true;
    }
  }

  // For checks: how far the filling stands above the pastry's roof anywhere in its footprint (should never be much),
  // how much lava there is outside the pocket and over how many cells (it should keep spreading), and in all.
  function stats() {
    let above = -1,
      outside = 0,
      wet = 0,
      total = 0,
      tallest = 0;
    for (let k = 0; k < cells; k++) {
      const h = depth[k];
      if (h <= DRY) continue;
      total += h;
      if (kind[k] === 1) above = Math.max(above, base[k] + h - roof[k]);
      else {
        outside += h;
        wet++;
        tallest = Math.max(tallest, h);
      }
    }
    return { above, outsideVolume: outside * DX * DX, wet, total: total * DX * DX, tallest, budget: lava.budget };
  }

  // The lava's surface height and temperature at a point, for crumbs to land on and steam to rise from.
  function sample(x: number, z: number) {
    const i = Math.max(0, Math.min(N - 1, Math.floor((x + SPAN) / DX)));
    const j = Math.max(0, Math.min(N - 1, Math.floor((z + SPAN) / DX)));
    const k = j * N + i;
    // The surface as drawn (the softened depth, raised as the mesh raises it), for what settles on it.
    const h = seen[k];
    const raise = shownRaise(h, floor[k * 4 + 3]);
    return { y: base[k] + depth[k], surface: base[k] + 0.0011 + raise, depth: depth[k], heat: heat[k], char: char[k] };
  }

  // A random cell with hot lava open to the air, for steam and smoke to rise from (or null).
  function hotCell(random: () => number) {
    if (!hot.length) return null;
    const k = hot[Math.floor(random() * hot.length)];
    const [x, z] = centre(k % N, Math.floor(k / N));
    return { x, z, y: base[k] + depth[k], heat: heat[k], char: char[k] };
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// How high the mesh stands over a cell's floor for its shown depth h: a rounded lip near the edge (as the square root of
// the depth), the depth and up to a centimetre more in the body, tapering to nothing before the outline; never above the pastry's roof
// (room: the headroom under it), and never below the depth itself. The lava shader raises it the same way.
export function shownRaise(h: number, room: number) {
  const full = Math.max(h + Math.min(h * 1.2, 0.004), Math.sqrt(h * 0.006)) * smooth(0.0008, 0.0045, h);
  return Math.max(Math.min(h, room), Math.min(full, room - 0.002));
}
