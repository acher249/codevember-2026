import * as THREE from "three/webgpu";
import { abs, cos, exp, float, Fn, If, instancedArray, instanceIndex, int, length, max, min, mix, normalize, select, sin, sqrt, uniform, vec3, vec4 } from "three/tsl";
import { COLLIDERS, HOOD, OPENING } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The veil: a sheet of tulle simulated on the graphics card, COLS across and ROWS down, row 0 pinned just inside the
// hood's rim round the top of the opening (gathered there: it is wider than the arc it hangs from). Position-based:
// Verlet through air that drags on cloth moving face first, then Jacobi constraint passes ping-ponged between two
// buffers (lengths to the neighbours beside, diagonal and two along; slack under compression so it folds), tethers to the
// pins and to the hand, and her face and the cloak pushing it out. Her breath, now and then, stirs it from behind.

export const WIDTH = 0.36;
export const LENGTH = 0.44;

// Where a hand holds the cloth: 5 columns by 3 rows round the particle taken.
const PATCH_I = 2;
const PATCH_J = 1;
const PATCH = (PATCH_I * 2 + 1) * (PATCH_J * 2 + 1);

const clampInt = (k: any, top: number) => (max as any)((min as any)(k, int(top)), int(0));

export type Cloth = ReturnType<typeof createCloth>;

export function createCloth(COLS: number, ROWS: number) {
  const N = COLS * ROWS;
  const du = WIDTH / (COLS - 1);
  const dv = LENGTH / (ROWS - 1);
  const A = instancedArray(N, "vec4") as any;
  const B = instancedArray(N, "vec4") as any;
  const prev = instancedArray(N, "vec4") as any;
  const offsets = instancedArray(PATCH, "vec4") as any;

  const u = {
    dt: uniform(1 / 180),
    time: uniform(0),
    gravity: uniform(9.8),
    breeze: uniform(1),
    // Her breath: how hard, and where it leaves her lips.
    breath: uniform(0),
    mouth: uniform(new THREE.Vector3(0, 1.547, 0.105)),
    // The hand: whether it holds the cloth, the particle it took (column, row) and where it wants it.
    holding: uniform(0),
    gi: uniform(0),
    gj: uniform(0),
    target: uniform(new THREE.Vector3())
  };

  // Each column's pin: on the arc round the top of the opening, a little inside the hood's rim.
  const pin = (i: any) => {
    const f = float(i).div(COLS - 1);
    const a = f.mul(0.88).add(0.06).mul(Math.PI);
    const x = cos(a).mul(OPENING.rx + 0.004);
    const y = sin(a)
      .mul(OPENING.ry + 0.004)
      .add(OPENING.centre.y);
    const ex = x.div(HOOD.radii.x);
    const ey = y.sub(HOOD.centre.y).div(HOOD.radii.y);
    const z = sqrt(float(1).sub(ex.mul(ex)).sub(ey.mul(ey)).max(0))
      .mul(HOOD.radii.z)
      .add(HOOD.centre.z - 0.006);
    return vec3(x, y, z) as any;
  };

  const coords = () => {
    const id = int(instanceIndex);
    const i = id.mod(COLS);
    const j = id.div(COLS);
    return { id, i, j };
  };
  const at = (buffer: any, i: any, j: any) => buffer.element(clampInt(j, ROWS - 1).mul(COLS).add(clampInt(i, COLS - 1))).xyz as any;
  const held = (i: any, j: any) =>
    u.holding
      .greaterThan(0.5)
      .and(abs(float(i).sub(u.gi)).lessThanEqual(PATCH_I))
      .and(abs(float(j).sub(u.gj)).lessThanEqual(PATCH_J)) as any;

  // A cold draught, slow and wandering, mostly across the opening; light enough that the tulle only stirs.
  const air = (p: any) => {
    const t = u.time as any;
    const q = p.mul(9) as any;
    const flow = vec3(
      sin(q.y.add(t.mul(0.37)).add(sin(q.z.mul(1.3).sub(t.mul(0.21))))),
      sin(q.z.mul(1.1).add(t.mul(0.29))).mul(0.35),
      sin(q.x.mul(1.4).sub(t.mul(0.33)).add(sin(q.y.mul(0.8).add(t.mul(0.17)))))
    ).mul(0.07) as any;
    // The breath: out from her lips, spreading, dying away with distance.
    const off = p.sub(u.mouth);
    const near = exp(length(off).mul(-38)) as any;
    const out = normalize(off.add(vec3(0, 0, 0.02))).mul(near.mul(u.breath).mul(1.6)) as any;
    return flow.mul(u.breeze).add(out) as any;
  };

  // Out of whatever it has sunk into: each collider in turn, a sphere swept along a segment.
  const collide = (p: any) => {
    const q = p.toVar();
    for (const c of COLLIDERS) {
      const a = vec3(c.a[0], c.a[1], c.a[2]);
      const ba = vec3(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
      const len2 = Math.max(1e-8, (c.b[0] - c.a[0]) ** 2 + (c.b[1] - c.a[1]) ** 2 + (c.b[2] - c.a[2]) ** 2);
      const t = q.sub(a).dot(ba).div(len2).clamp(0, 1);
      const nearest = a.add(ba.mul(t));
      const off = q.sub(nearest);
      const d = length(off).max(1e-6);
      const r = c.r + 0.003;
      If(d.lessThan(r), () => {
        q.assign(nearest.add(off.mul(float(r).div(d))));
      });
    }
    // The hood: the veil lies over its outside wherever it is not in front of the opening.
    const h = q.sub(vec3(HOOD.centre.x, HOOD.centre.y, HOOD.centre.z)).div(vec3(HOOD.radii.x, HOOD.radii.y, HOOD.radii.z)).toVar();
    const hl = length(h).max(1e-6);
    const ovalX = q.x.div(OPENING.rx);
    const ovalY = q.y.sub(OPENING.centre.y).div(OPENING.ry);
    const outside = length(vec3(ovalX, ovalY, 0)) as any;
    If(hl.lessThan(1.04).and(outside.greaterThan(0.92)), () => {
      q.assign(vec3(HOOD.centre.x, HOOD.centre.y, HOOD.centre.z).add(h.mul(float(1.04).div(hl)).mul(vec3(HOOD.radii.x, HOOD.radii.y, HOOD.radii.z))));
    });
    return q;
  };

  const integrate = Fn(() => {
    const { id, i, j } = coords();
    If(j.equal(0), () => {
      const p = pin(i);
      A.element(id).assign(vec4(p, 1));
      prev.element(id).assign(vec4(p, 1));
    }).Else(() => {
      const p = A.element(id).xyz.toVar();
      const q = prev.element(id).xyz;
      const dt = u.dt;
      const vel = p.sub(q).mul(0.995).toVar();
      const across = at(A, i.add(1), j).sub(at(A, i.sub(1), j));
      const along = at(A, i, j.add(1)).sub(at(A, i, j.sub(1)));
      const n = normalize(across.cross(along).add(vec3(0, 1e-6, 0))) as any;
      // Tulle is mostly holes: little drag face on, a little more along.
      const rel = vel.div(dt).sub(air(p)) as any;
      const acc = vec3(0, u.gravity.negate(), 0)
        .sub(n.mul(rel.dot(n)).mul(2.6))
        .sub(rel.mul(0.25))
        .toVar();
      const next = p.add(vel).add(acc.mul(dt.mul(dt))).toVar();
      If(held(i, j), () => {
        const k = j
          .sub(int(u.gj))
          .add(PATCH_J)
          .mul(PATCH_I * 2 + 1)
          .add(i.sub(int(u.gi)).add(PATCH_I));
        next.assign(mix(p, u.target.add(offsets.element(k).xyz), float(1).sub(exp(dt.mul(-40)))));
      });
      prev.element(id).assign(vec4(p, 1));
      A.element(id).assign(vec4(next, 1));
    });
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
    [2, 0, 0.1],
    [-2, 0, 0.1],
    [0, 2, 0.1],
    [0, -2, 0.1]
  ];
  const solve = (src: any, dst: any) =>
    Fn(() => {
      const { id, i, j } = coords();
      const p = src.element(id).xyz.toVar();
      If(j.equal(0).or(held(i, j)), () => {
        dst.element(id).assign(vec4(p, 1));
      }).Else(() => {
        const sum = vec3(0).toVar();
        const weight = float(0).toVar();
        for (const [di, dj, stiff] of NEIGHBOURS) {
          const ni = i.add(di);
          const nj = j.add(dj);
          If(ni.greaterThanEqual(0).and(ni.lessThan(COLS)).and(nj.greaterThanEqual(0)).and(nj.lessThan(ROWS)), () => {
            const q = src.element(nj.mul(COLS).add(ni)).xyz;
            const d = p.sub(q);
            const len = length(d).max(1e-6);
            const rest = Math.hypot(di * du, dj * dv);
            const fixed = nj.equal(0).or(held(ni, nj));
            const share = select(fixed, float(1), float(0.5));
            // Slack under compression, so it gathers and folds; firm against stretch.
            const c = float(rest).sub(len).div(len).toVar();
            c.assign(select(c.greaterThan(0), c.mul(0.15), c));
            sum.addAssign(d.mul(c.mul(share).mul(stiff)));
            weight.addAssign(stiff);
          });
        }
        const next = p.add(sum.mul(float(1.4).div(weight.max(1)))).toVar();
        // Tether to its pin: never further than the cloth between them reaches.
        const anchor = pin(i);
        const most = float(j).mul(dv * 1.01).add(0.002);
        const off = next.sub(anchor).toVar();
        const far = length(off).max(1e-6);
        If(far.greaterThan(most), () => {
          next.assign(anchor.add(off.mul(most.div(far))));
        });
        // Tether to the hand.
        If(u.holding.greaterThan(0.5), () => {
          const g = u.target;
          const ai = float(i).sub(u.gi).mul(du) as any;
          const aj = float(j).sub(u.gj).mul(dv) as any;
          const reach = sqrt(ai.mul(ai).add(aj.mul(aj)))
            .mul(1.03)
            .add(0.004);
          const away = next.sub(g).toVar();
          const gap = length(away).max(1e-6);
          If(gap.greaterThan(reach), () => {
            next.assign(g.add(away.mul(reach.div(gap))));
          });
        });
        dst.element(id).assign(vec4(collide(next), 1));
      });
    })().compute(N);

  // Taking hold: the patch round the particle taken keeps its shape as it is now, relative to that particle.
  const takeHold = Fn(() => {
    const k = int(instanceIndex);
    const di = k.mod(PATCH_I * 2 + 1).sub(PATCH_I);
    const dj = k.div(PATCH_I * 2 + 1).sub(PATCH_J);
    const gi = int(u.gi);
    const gj = int(u.gj);
    offsets.element(k).assign(vec4(at(A, gi.add(di), gj.add(dj)).sub(at(A, gi, gj)), 0));
  })().compute(PATCH);

  // At rest: hanging straight down from each pin, held a little forward of her face, to settle from.
  const reset = Fn(() => {
    const { id, i, j } = coords();
    const p = pin(i);
    const spread = float(i)
      .div(COLS - 1)
      .sub(0.5)
      .mul(WIDTH - 0.2)
      .mul(float(j).div(ROWS - 1));
    const hang = p.add(vec3(spread, float(j).mul(dv).negate(), float(j).mul(dv).mul(0.35))) as any;
    A.element(id).assign(vec4(hang, 1));
    prev.element(id).assign(vec4(hang, 1));
  })().compute(N);

  return { N, COLS, ROWS, du, dv, A, u, integrate: integrate().compute(N), forth: solve(A, B), back: solve(B, A), takeHold, reset };
}
