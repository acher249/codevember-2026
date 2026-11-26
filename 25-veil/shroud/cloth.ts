import * as THREE from "three/webgpu";
import { abs, exp, float, floor, Fn, If, smoothstep, instancedArray, instanceIndex, int, length, max, min, mix, normalize, select, sin, sqrt, uniform, vec2, vec3, vec4 } from "three/tsl";
import { BODY, CROWN, YAW } from "./body";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The shroud: one square of white chiffon, N particles a side, simulated on the graphics card. Laid flat over her head
// and let fall, it settles over the figure under it into the folds it finds. Position-based: Verlet through air that drags
// on cloth moving face first; Jacobi constraint passes ping-ponged between two buffers (lengths to the neighbours beside,
// diagonal and two along; slack under compression so it folds); every particle held within its reach across the cloth of
// the middle, so the sheet does not stretch however long it hangs; friction where it lies on her or the floor.

export const SIZE = 2.8;

// Where a hand holds the cloth: 5 by 5 round the particle taken.
const PATCH_R = 2;
const PATCH_W = PATCH_R * 2 + 1;
const PATCH = PATCH_W * PATCH_W;
// How many rows in from a hem the hand holds when it takes the hem.
const HEM = 3;

const clampInt = (k: any, top: number) => (max as any)((min as any)(k, int(top)), int(0));

const CELL = 0.02;
const LO = [-1.6, -0.02, -1.6];
const GRID = { x: 160, y: 70, z: 160 };
// How close two layers may come.
const THICK = 0.013;

export type Shroud = ReturnType<typeof createShroud>;

export function createShroud(N: number) {
  const rows = N;
  const COUNT = N * N;
  const d = SIZE / (N - 1);
  const MID = Math.floor(N / 2);
  const MIDJ = MID;
  // Its middle, which lies caught on her crown where it was laid until someone takes it off.
  const PIN = MID * N + MID;
  const A = instancedArray(COUNT, "vec4") as any;
  const B = instancedArray(COUNT, "vec4") as any;
  const prev = instancedArray(COUNT, "vec4") as any;
  const offsets = instancedArray(PATCH, "vec4") as any;
  // A stretch of one hem held flat, as a hand holds a shawl's edge to wrap it: each particle's place from the stretch's middle.
  const along = instancedArray(N * HEM, "vec4") as any;
  // Itself: a grid of cells over the room round her, each remembering one particle that lay in it on this step (and
  // which step, so it never needs clearing), so cloth lying on cloth can push apart without anything sorted.
  const cells = instancedArray(GRID.x * GRID.y * GRID.z, "vec2") as any;

  const u = {
    dt: uniform(1 / 180),
    time: uniform(0),
    gravity: uniform(9.8),
    // How thick the air is to it: high while it first settles, so it falls like cloth and not like a sheet of tin.
    drag: uniform(1),
    breeze: uniform(0),
    // Her breath: 1 full in, 0 out.
    breath: uniform(0),
    // Whether its middle still lies on the crown of her head: until someone takes it off her.
    crowned: uniform(1),
    holding: uniform(0),
    // The hem held: on (1), along which edge (0: a row, j = edge; 1: a column, i = edge), and from where to where along it.
    wrapping: uniform(0),
    edgeIsColumn: uniform(0),
    edge: uniform(0),
    from: uniform(0),
    to: uniform(0),
    gi: uniform(0),
    gj: uniform(0),
    target: uniform(new THREE.Vector3()),
    stamp: uniform(0),
    // Kept of its speed each step: lowered as it comes to rest, so it settles rather than freezes mid-swing.
    damp: uniform(0.997),
    // How hard it is drawn in to her while it is laid (m/s²); nothing once it lies.
    hug: uniform(0)
  };

  const coords = () => {
    const id = int(instanceIndex);
    return { id, i: id.mod(N), j: id.div(N) };
  };
  const at = (buffer: any, i: any, j: any) => buffer.element(clampInt(j, rows - 1).mul(N).add(clampInt(i, N - 1))).xyz as any;
  // Where along the held edge (i,j) lies, and whether it is in the stretch held.
  const onEdge = (i: any, j: any) => {
    const column = u.edgeIsColumn.greaterThan(0.5);
    const across = float(select(column, i, j)) as any;
    const k = float(select(column, j, i)) as any;
    const deep = abs(across.sub(u.edge)) as any;
    return {
      slot: int(deep).mul(N).add(int(k)),
      held: u.wrapping.greaterThan(0.5).and(deep.lessThan(HEM)).and(k.greaterThanEqual(u.from)).and(k.lessThanEqual(u.to)) as any
    };
  };
  const held = (i: any, j: any) =>
    u.holding
      .greaterThan(0.5)
      .and(abs(float(i).sub(u.gi)).lessThanEqual(PATCH_R))
      .and(abs(float(j).sub(u.gj)).lessThanEqual(PATCH_R))
      .or(onEdge(i, j).held) as any;

  const crown = (id: any) => u.crowned.greaterThan(0.5).and(id.equal(PIN)) as any;

  // A still room: only the faintest drift, enough that the hem is never quite dead.
  const air = (p: any) => {
    const t = u.time as any;
    const q = p.mul(3) as any;
    return vec3(sin(q.y.add(t.mul(0.31))), 0, sin(q.x.mul(1.2).sub(t.mul(0.23)))).mul(u.breeze.mul(0.05)) as any;
  };

  const radius = (c: (typeof BODY)[number]) => (c.breathes ? float(c.r).mul(u.breath.mul(0.05).add(1)) : float(c.r)) as any;

  // How far into the nearest of her shapes, or the floor (negative inside, metres).
  const clearance = (p: any) => {
    const gap = p.y.sub(0.002).toVar();
    for (const c of BODY) {
      const a = vec3(c.a[0], c.a[1], c.a[2]);
      const ba = vec3(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
      const len2 = Math.max(1e-8, (c.b[0] - c.a[0]) ** 2 + (c.b[1] - c.a[1]) ** 2 + (c.b[2] - c.a[2]) ** 2);
      const t = p.sub(a).dot(ba).div(len2).clamp(0, 1);
      gap.assign(min(gap, length(p.sub(a.add(ba.mul(t)))).sub(radius(c))));
    }
    return gap;
  };

  // Which way is toward her from p, and how far to her (only the nearest of her shapes, not the floor).
  const toward = (p: any) => {
    const gap = float(9).toVar();
    const way = vec3(0).toVar();
    for (const c of BODY) {
      const a = vec3(c.a[0], c.a[1], c.a[2]);
      const ba = vec3(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
      const len2 = Math.max(1e-8, (c.b[0] - c.a[0]) ** 2 + (c.b[1] - c.a[1]) ** 2 + (c.b[2] - c.a[2]) ** 2);
      const t = p.sub(a).dot(ba).div(len2).clamp(0, 1);
      const off = a.add(ba.mul(t)).sub(p);
      const dist = length(off).max(1e-6);
      If(dist.sub(radius(c)).lessThan(gap), () => {
        gap.assign(dist.sub(radius(c)));
        way.assign(off.div(dist));
      });
    }
    return { gap, way };
  };

  // Out of whatever it has sunk into: each shape in turn, then the floor.
  const collide = (p: any) => {
    const q = p.toVar();
    for (const c of BODY) {
      const a = vec3(c.a[0], c.a[1], c.a[2]);
      const ba = vec3(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
      const len2 = Math.max(1e-8, (c.b[0] - c.a[0]) ** 2 + (c.b[1] - c.a[1]) ** 2 + (c.b[2] - c.a[2]) ** 2);
      const t = q.sub(a).dot(ba).div(len2).clamp(0, 1);
      const nearest = a.add(ba.mul(t));
      const off = q.sub(nearest);
      const dist = length(off).max(1e-6);
      const r = radius(c).add(0.004);
      If(dist.lessThan(r), () => {
        q.assign(nearest.add(off.mul(r.div(dist))));
      });
    }
    q.y.assign(max(q.y, 0.002));
    return q;
  };

  const integrate = Fn(() => {
    const { id, i, j } = coords();
    const p = A.element(id).xyz.toVar();
    const q = prev.element(id).xyz;
    const dt = u.dt;
    const vel = p.sub(q).mul(u.damp).toVar();
    // Lying on her or on the floor, it holds where it lies unless pulled.
    // On her, on the floor, or on another layer of itself: it holds where it lies unless pulled, cloth catching on cloth.
    const touching = clearance(p).lessThan(0.008).or(onItself(p, i, j));
    vel.mulAssign(select(touching, float(0.03), float(1)));
    const across = at(A, i.add(1), j).sub(at(A, i.sub(1), j));
    const along = at(A, i, j.add(1)).sub(at(A, i, j.sub(1)));
    const n = normalize(across.cross(along).add(vec3(0, 1e-6, 0))) as any;
    const rel = vel.div(dt).sub(air(p)) as any;
    const acc = vec3(0, u.gravity.negate(), 0)
      .sub(n.mul(rel.dot(n)).mul(u.drag.mul(1.4)))
      .sub(rel.mul(u.drag.mul(0.12)))
      .toVar();
    // Wrapped to her as it is laid: drawn in toward whatever of her is near, as hands would smooth it to her.
    const near = toward(p);
    // About her head and face, harder and closer, so the cloth lies on them as it does in the photograph.
    const head = smoothstep(1.02, 1.12, p.y) as any;
    acc.addAssign(near.way.mul(u.hug.mul(head.mul(1.5).add(1)).mul(float(1).sub(smoothstep(0.08, 0.3, near.gap)))));
    const next = p.add(vel).add(acc.mul(dt.mul(dt))).toVar();
    If(crown(id), () => {
      next.assign(vec3(CROWN[0], CROWN[1], CROWN[2]));
    });
    const hem = onEdge(i, j);
    If(hem.held, () => {
      next.assign(mix(p, u.target.add(along.element(hem.slot).xyz), float(1).sub(exp(dt.mul(-10)))));
    }).ElseIf(held(i, j), () => {
      const k = j
        .sub(int(u.gj))
        .add(PATCH_R)
        .mul(PATCH_W)
        .add(i.sub(int(u.gi)).add(PATCH_R));
      next.assign(mix(p, u.target.add(offsets.element(k).xyz), float(1).sub(exp(dt.mul(-40)))));
    });
    prev.element(id).assign(vec4(p, 1));
    A.element(id).assign(vec4(next, 1));
  });

  const NEIGHBOURS: [number, number, number][] = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, 0.5],
    [-1, -1, 0.5],
    [1, -1, 0.5],
    [-1, 1, 0.5],
    [2, 0, 0.25],
    [-2, 0, 0.25],
    [0, 2, 0.25],
    [0, -2, 0.25]
  ];
  const solve = (src: any, dst: any) =>
    Fn(() => {
      const { id, i, j } = coords();
      const p = src.element(id).xyz.toVar();
      If(held(i, j).or(crown(id)), () => {
        dst.element(id).assign(vec4(p, 1));
      }).Else(() => {
        const sum = vec3(0).toVar();
        const weight = float(0).toVar();
        for (const [di, dj, stiff] of NEIGHBOURS) {
          const ni = i.add(di);
          const nj = j.add(dj);
          If(ni.greaterThanEqual(0).and(ni.lessThan(N)).and(nj.greaterThanEqual(0)).and(nj.lessThan(rows)), () => {
            const o = src.element(nj.mul(N).add(ni)).xyz;
            const off = p.sub(o);
            const len = length(off).max(1e-6);
            const share = select(held(ni, nj).or(crown(nj.mul(N).add(ni))), float(1), float(0.5));
            // A heavy crêpe: some give under compression, so it folds, but it holds its folds round and full.
            const c = float(Math.hypot(di, dj) * d)
              .sub(len)
              .div(len)
              .toVar();
            // (Only between neighbours: the springs two along resist bending both ways, so folds stay round, never tubes.)
            if (Math.hypot(di, dj) < 1.9) c.assign(select(c.greaterThan(0), c.mul(0.4), c));
            sum.addAssign(off.mul(c.mul(share).mul(stiff)));
            weight.addAssign(stiff);
          });
        }
        const next = p.add(sum.mul(float(1.5).div(weight.max(1)))).toVar();
        // Never further from the middle than the cloth between them reaches.
        const mid = at(src, int(MID), int(MIDJ));
        const di = float(i).sub(MID) as any;
        const dj = float(j).sub(MIDJ) as any;
        const most = sqrt(di.mul(di).add(dj.mul(dj)))
          .mul(d * 1.01)
          .add(0.002);
        const away = next.sub(mid).toVar();
        const far = length(away).max(1e-6);
        If(far.greaterThan(most), () => {
          next.assign(mid.add(away.mul(most.div(far))));
        });
        // Nor from the hand.
        If(u.holding.greaterThan(0.5), () => {
          const ai = float(i).sub(u.gi) as any;
          const aj = float(j).sub(u.gj) as any;
          const reach = sqrt(ai.mul(ai).add(aj.mul(aj)))
            .mul(d * 1.03)
            .add(0.004);
          const fromHand = next.sub(u.target).toVar();
          const gap = length(fromHand).max(1e-6);
          If(gap.greaterThan(reach), () => {
            next.assign(u.target.add(fromHand.mul(reach.div(gap))));
          });
        });
        dst.element(id).assign(vec4(collide(next), 1));
      });
    })().compute(COUNT);

  const cellOf = (c: any) => c.x.add(c.y.mul(GRID.x)).add(c.z.mul(GRID.x * GRID.y)) as any;
  const inGrid = (c: any) =>
    c.x
      .greaterThanEqual(0)
      .and(c.y.greaterThanEqual(0))
      .and(c.z.greaterThanEqual(0))
      .and(c.x.lessThan(GRID.x))
      .and(c.y.lessThan(GRID.y))
      .and(c.z.lessThan(GRID.z)) as any;
  const cellAt = (p: any) => {
    const f = floor(p.sub(vec3(LO[0], LO[1], LO[2])).div(CELL)) as any;
    return { x: int(f.x), y: int(f.y), z: int(f.z) } as any;
  };

  // Whether another layer of itself lies against p (as last marked, a step ago).
  function onItself(p: any, i: any, j: any) {
    const touch = float(0).toVar();
    const c = cellAt(p);
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const n = { x: c.x.add(dx), y: c.y.add(dy), z: c.z.add(dz) };
          If(inGrid(n), () => {
            const e = cells.element(cellOf(n)) as any;
            const k = int(e.x);
            const near = (max as any)(abs(k.mod(N).sub(i)), abs(k.div(N).sub(j)));
            If(e.y.equal(u.stamp.sub(1)).and(near.greaterThan(3)).and(length(p.sub(A.element(k).xyz)).lessThan(THICK + 0.005)), () => {
              touch.assign(1);
            });
          });
        }
    return touch.greaterThan(0.5);
  }

  const mark = Fn(() => {
    const { id } = coords();
    const c = cellAt(B.element(id).xyz);
    If(inGrid(c), () => {
      cells.element(cellOf(c)).assign(vec2(float(id), u.stamp));
    });
  })().compute(COUNT);

  // Away from any other part of itself lying closer than THICK, then out of her again.
  const apart = Fn(() => {
    const { id, i, j } = coords();
    const p = B.element(id).xyz.toVar();
    const push = vec3(0).toVar();
    const c = cellAt(p);
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const n = { x: c.x.add(dx), y: c.y.add(dy), z: c.z.add(dz) };
          If(inGrid(n), () => {
            const e = cells.element(cellOf(n)) as any;
            const k = int(e.x);
            const near = (max as any)(abs(k.mod(N).sub(i)), abs(k.div(N).sub(j)));
            If(e.y.equal(u.stamp).and(near.greaterThan(2)), () => {
              const off = p.sub(B.element(k).xyz);
              const dist = length(off);
              If(dist.lessThan(THICK), () => {
                push.addAssign(off.div(dist.max(1e-5)).mul(float(THICK).sub(dist).mul(0.5)));
              });
            });
          });
        }
    const next = p.add(push).toVar();
    If(held(i, j).or(crown(id)), () => {
      next.assign(p);
    });
    A.element(id).assign(vec4(collide(next), 1));
  })().compute(COUNT);

  // Taking hold: the patch round the particle taken keeps its shape as it is now, relative to that particle.
  const takeHold = Fn(() => {
    const k = int(instanceIndex);
    const di = k.mod(PATCH_W).sub(PATCH_R);
    const dj = k.div(PATCH_W).sub(PATCH_R);
    const gi = int(u.gi);
    const gj = int(u.gj);
    offsets.element(k).assign(vec4(at(A, gi.add(di), gj.add(dj)).sub(at(A, gi, gj)), 0));
  })().compute(PATCH);

  // Taking the hem: the stretch as it lies now, from its middle.
  const takeEdge = Fn(() => {
    const slot = int(instanceIndex);
    const k = slot.mod(N);
    const column = u.edgeIsColumn.greaterThan(0.5);
    const edge = int(u.edge);
    // Rows in from the hem: inward, whichever side of the cloth it is.
    const e = edge.add(slot.div(N).mul(select(edge.equal(0), int(1), int(-1))));
    const m = int(u.from.add(u.to).mul(0.5));
    const here = select(column, at(A, e, k), at(A, k, e)) as any;
    const middle = select(column, at(A, edge, m), at(A, m, edge)) as any;
    along.element(slot).assign(vec4(here.sub(middle), 0));
  })().compute(N * HEM);

  // To start: flat, just over her head, turned a little so it does not fall square to her.
  const reset = Fn(() => {
    const { id, i, j } = coords();
    const x = float(i).sub(MID).mul(d) as any;
    const z = float(j).sub(MID).mul(d) as any;
    const turn = 0.5 + YAW;
    const p = vec3(
      x.mul(Math.cos(turn)).sub(z.mul(Math.sin(turn))).add(CROWN[0]),
      float(CROWN[1] + 0.012),
      x.mul(Math.sin(turn)).add(z.mul(Math.cos(turn))).add(CROWN[2])
    );
    A.element(id).assign(vec4(p, 1));
    prev.element(id).assign(vec4(p, 1));
  })().compute(COUNT);

  // Laid as it was saved (x, y, z, 1 for each particle), at rest.
  const restore = (data: Float32Array) => {
    for (const buffer of [A, prev]) {
      buffer.value.array.set(data);
      buffer.value.needsUpdate = true;
    }
  };

  return { N, rows, COUNT, MID, PIN, d, A, cells, u, restore, integrate: integrate().compute(COUNT), forth: solve(A, B), back: solve(B, A), mark, apart, takeHold, takeEdge, reset };
}
