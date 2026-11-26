"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three/webgpu";
import { Fn, attribute, cross, float, fract, int, ivec2, max, min, modelWorldMatrix, normalGeometry, normalLocal, normalize, positionGeometry, screenCoordinate, textureLoad, uniform, vec3, vec4 } from "three/tsl";
import { lightDevice, parts as figureParts, type FigureData } from "../photo/figure";
import { WIDTH, type Field } from "./field";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Always on: the statues become cloth again, held to their form as if on her, a calm breeze passing slowly
// over them, now and then a gentle gust a little stronger: the folds keep their shape and sway as whole pieces, as heavier
// silk would, the swags and the hem lifting and settling, as if in slow motion. The motion is a 14 s loop simulated
// offline at 5 mm, with everything finer than a few centimetres filtered out (field.ts).
//
// As the unveiling was: the loop's keys sit in a texture on the GPU (some thirty thousand moving points, 15 keys a
// second). The file is fetched as the page opens, alongside the figure, and unpacked and bound in a worker as soon as
// the figure is built; the statues wait for it behind the loader, which stays up until it is on the GPU and the passes
// have run, so the scene opens already moving. Each frame two small passes run on the GPU: one eases each moving point
// between its keys (Catmull-Rom) for each statue's own moment in the loop; the other works out how its normal has
// turned, from its four neighbours moved and at rest. Each point of
// a statue follows its four nearest field points (bound once, in the worker), so the photograph's detail is all kept and
// only moved, and its normal turns with the cloth's, so the swaying folds catch the light. The statue's shader is the
// moving one from the start, so nothing is compiled once the scene shows.

// The three seats, told apart in the shader by where each stands (x): the near one at 0, one to the left, one to the
// right (blur/scene.tsx SEATS). All three play the one loop, each from its own moment, picked at random each visit with at
// least 3 s of the 14 s loop between any two, so they never sway together.
const PHASES = (() => {
  const apart = 3 / 14;
  for (;;) {
    const p = [Math.random(), Math.random(), Math.random()];
    const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
    if (gap(p[0], p[1]) >= apart && gap(p[0], p[2]) >= apart && gap(p[1], p[2]) >= apart) return p;
  }
})();

type Rig = {
  keys: THREE.DataArrayTexture;
  rest: THREE.DataTexture;
  around: THREE.DataTexture;
  move: THREE.RenderTarget;
  turn: THREE.RenderTarget;
  // How many points move, rows a key (and a seat) takes, keys; each seat's key (fractional); how strong it is.
  moving: any;
  rows: any;
  count: any;
  keyAt: any;
  amount: any;
  field: Field | null;
  // Bound and on her meshes, still to be sent to the GPU (on the first frame, behind the loader).
  arrived: Field | null;
  meshes: THREE.BufferGeometry[];
};
const rigs = new WeakMap<FigureData, Rig>();

const placeholder = (type: THREE.TextureDataType) => {
  const t = new THREE.DataTexture(type === THREE.HalfFloatType ? new Uint16Array(4) : new Float32Array(4), 1, 1, THREE.RGBAFormat, type);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
};
const target = () => new THREE.RenderTarget(WIDTH, 3, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });

// The breeze's GPU side for this figure, made at once with nothing in it: still bindings on her meshes (so their shaders
// are the moving ones from the start), and textures to be filled when the data comes.
function rigFor(data: FigureData): Rig {
  let rig = rigs.get(data);
  if (rig) return rig;
  const parts = figureParts(data);
  const meshes = [parts.near, parts.far, parts.solid, parts.hem];
  for (const g of meshes) {
    const n = g.attributes.position.count;
    g.setAttribute("windAt", new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    g.setAttribute("windBy", new THREE.BufferAttribute(new Uint8Array(n * 4), 4, true));
  }
  rig = {
    keys: (() => {
      const t = new THREE.DataArrayTexture(new Uint16Array(4), 1, 1, 1);
      t.type = THREE.HalfFloatType;
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    })(),
    rest: placeholder(THREE.FloatType),
    around: placeholder(THREE.FloatType),
    move: target(),
    turn: target(),
    moving: uniform(0),
    rows: uniform(1),
    count: uniform(1),
    keyAt: uniform(new THREE.Vector3()),
    amount: uniform(0),
    field: null,
    arrived: null,
    meshes
  };
  rigs.set(data, rig);
  return rig;
}

function fill(texture: THREE.DataTexture, data: ArrayBufferView, rows: number) {
  texture.image = { data, width: WIDTH, height: rows } as any;
  texture.needsUpdate = true;
}

// The file, fetched as soon as this module loads (with the page), so it comes down alongside the figure's: a phone's own
// lighter export (a point every 1.5 cm, 5 keys a second), or the full one.
const PHONE = "/assets/25-veil/wind-phone.bin.gz";
const FULL = "/assets/25-veil/wind-hd.bin.gz";
const light = typeof window !== "undefined" && lightDevice();
const file = light ? PHONE : FULL;
const fetched: Promise<ArrayBuffer | null> | null =
  typeof window === "undefined"
    ? null
    : fetch(file)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);

// The breeze for this figure, ready to show: unpacked and bound in a worker (the figure's meshes sent to it), the
// bindings in place on the meshes. The statues wait on it (Suspense), so the loader stays up meanwhile. If it cannot be
// had, it resolves all the same and they stand still.
const loads = new WeakMap<FigureData, Promise<Rig>>();
export function breezeFor(data: FigureData): Promise<Rig> {
  let made = loads.get(data);
  if (made) return made;
  const rig = rigFor(data);
  made = (fetched ?? Promise.resolve(null)).then(
    (buffer) =>
      new Promise<Rig>((resolve) => {
        if (!buffer) return resolve(rig);
        const worker = new Worker(new URL("./wind-worker.ts", import.meta.url));
        worker.onmessage = (event: MessageEvent) => {
          worker.terminate();
          if (event.data.error) {
            console.warn(event.data.error);
            return resolve(rig);
          }
          const { field, binds } = event.data as { field: Field; binds: { at: Float32Array; by: Uint8Array }[] };
          rig.meshes.forEach((g, k) => {
            (g.attributes.windAt as THREE.BufferAttribute).array = binds[k].at;
            (g.attributes.windBy as THREE.BufferAttribute).array = binds[k].by;
          });
          rig.arrived = field;
          resolve(rig);
        };
        worker.onerror = (event) => {
          worker.terminate();
          console.warn(event.message || "The breeze could not be loaded.");
          resolve(rig);
        };
        // Copies, of the meshes since they keep theirs, and of the file so a world made again can bind it again.
        worker.postMessage({ buffer: buffer.slice(0), file, light, meshes: rig.meshes.map((g) => ({ position: (g.attributes.position.array as Float32Array).slice(), normal: (g.attributes.normal.array as Float32Array).slice() })) });
      })
  );
  loads.set(data, made);
  return made;
}

// Onto the GPU in one go, on the first frame, which the loader still covers: the bindings, the textures filled and sized,
// and the passes and the statues told how many points move.
function upload(rig: Rig, field: Field) {
  for (const g of rig.meshes)
    for (const name of ["windAt", "windBy"]) (g.attributes[name] as THREE.BufferAttribute).needsUpdate = true;
  rig.keys.image = { data: field.keys, width: WIDTH, height: field.rows, depth: (field.keys.length / 4 / WIDTH / field.rows) | 0 } as any;
  rig.keys.needsUpdate = true;
  fill(rig.rest, field.rest, (field.rest.length / 4 / WIDTH) | 0);
  fill(rig.around, field.around, field.rows);
  rig.move.setSize(WIDTH, field.rows * 3);
  rig.turn.setSize(WIDTH, field.rows * 3);
  rig.rows.value = field.rows;
  rig.count.value = rig.keys.image.depth;
  rig.moving.value = field.moving;
  rig.field = field;
  rig.arrived = null;
  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __breeze: { at: performance.now(), moving: field.moving, keys: rig.count.value } });
}

// Which seat a statue stands on, from where it stands.
const seatHere = () => {
  const x = (modelWorldMatrix as any).element(3).x as any;
  return x.lessThan(-0.3).select(int(1), x.greaterThan(0.3).select(int(2), int(0))) as any;
};
// A field point's texel in a pass's output for a seat (j below the moving count).
const texel = (j: any, seat: any, rows: any) => ivec2(j.mod(WIDTH), seat.mul(int(rows)).add(j.div(WIDTH))) as any;

// The statue's point where the breeze has it, its normal turned with the cloth's: for a material's positionNode (in place
// of positionGeometry). Its four field points' moves and turns, mixed by their weights (an anchor's are none).
export function breeze(rig: Rig) {
  return Fn(() => {
    const at = attribute("windAt", "vec4") as any;
    const by = attribute("windBy", "vec4") as any;
    const seat = seatHere();
    const moving = int(rig.moving) as any;
    let move = vec3(0, 0, 0) as any;
    let turn = vec3(0, 0, 0) as any;
    for (const c of ["x", "y", "z", "w"]) {
      const j = int(at[c]) as any;
      const w = by[c].mul(j.lessThan(moving).select(float(1), float(0))) as any;
      const t = texel((min as any)(j, (max as any)(moving.sub(1), int(0))), seat, rig.rows);
      move = move.add(textureLoad(rig.move.texture, t).xyz.mul(w));
      turn = turn.add(textureLoad(rig.turn.texture, t).xyz.mul(w));
    }
    normalLocal.assign(normalize(normalGeometry.add(turn)));
    return positionGeometry.add(move);
  })() as any;
}

// The two passes: each seat's moves at its moment, eased between keys; then each moving point's normal's turn.
function passes(rig: Rig) {
  const where = () => {
    const px = int(screenCoordinate.x) as any;
    const py = int(screenCoordinate.y) as any;
    const rows = int(rig.rows) as any;
    const seat = py.div(rows) as any;
    const row = py.sub(seat.mul(rows)) as any;
    return { px, seat, row, rows, i: row.mul(WIDTH).add(px) as any };
  };
  const moveMaterial = new THREE.NodeMaterial();
  moveMaterial.fragmentNode = Fn(() => {
    const { px, seat, row, rows } = where();
    const k = rig.keyAt as any;
    const now = seat.equal(int(0)).select(k.x, seat.equal(int(1)).select(k.y, k.z)) as any;
    const n = int(rig.count) as any;
    const k1 = int(now.floor()) as any;
    const t = fract(now) as any;
    const key = (o: number) => (textureLoad(rig.keys, ivec2(px, row)) as any).depth(k1.add(o).add(n).mod(n)).xyz as any;
    const [p0, p1, p2, p3] = [key(-1), key(0), key(1), key(2)];
    const t2 = t.mul(t) as any;
    const t3 = t2.mul(t) as any;
    const p = p1
      .mul(2)
      .add(p2.sub(p0).mul(t))
      .add(p0.mul(2).sub(p1.mul(5)).add(p2.mul(4)).sub(p3).mul(t2))
      .add(p1.mul(3).sub(p0).sub(p2.mul(3)).add(p3).mul(t3))
      .mul(0.5) as any;
    return vec4(p.mul(rig.amount), 1);
  })() as any;
  const turnMaterial = new THREE.NodeMaterial();
  turnMaterial.fragmentNode = Fn(() => {
    const { px, seat, row } = where();
    const moving = int(rig.moving) as any;
    const around = textureLoad(rig.around, ivec2(px, row)) as any;
    const still = (j: any) => textureLoad(rig.rest, ivec2(j.mod(WIDTH), j.div(WIDTH))).xyz as any;
    const moved = (j: any) => still(j).add(textureLoad(rig.move.texture, texel((min as any)(j, (max as any)(moving.sub(1), int(0))), seat, rig.rows)).xyz.mul(j.lessThan(moving).select(float(1), float(0)))) as any;
    const [e, w, n, s] = ["x", "y", "z", "w"].map((c) => int(around[c]) as any);
    const now = cross(moved(e).sub(moved(w)), moved(n).sub(moved(s))) as any;
    const then = cross(still(e).sub(still(w)), still(n).sub(still(s))) as any;
    const ok = now.length().greaterThan(1e-10).and(then.length().greaterThan(1e-10)) as any;
    return vec4(ok.select(normalize(now).sub(normalize(then)), vec3(0, 0, 0)), 1);
  })() as any;
  return { move: new THREE.QuadMesh(moveMaterial), turn: new THREE.QuadMesh(turnMaterial), materials: [moveMaterial, turnMaterial] };
}

// Each frame: each seat's moment in the loop, the two passes, at full strength from the first frame (the loader covers the
// upload and the passes' first build).
export function useBreeze(rig: Rig) {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;
  const state = useRef({ time: 0, quads: null as ReturnType<typeof passes> | null });
  useEffect(() => {
    const s = state.current;
    s.quads = passes(rig);
    return () => {
      s.quads?.materials.forEach((m) => m.dispose());
      s.quads = null;
    };
  }, [rig]);
  useFrame((_, delta) => {
    const s = state.current;
    if (!s.quads) return;
    if (rig.arrived) upload(rig, rig.arrived);
    const field = rig.field;
    if (!field) return;
    s.time += Math.min(delta, 0.1);
    const keys = rig.count.value as number;
    const at = (phase: number) => (((s.time * field.rate) / keys + phase) % 1) * keys;
    (rig.keyAt.value as THREE.Vector3).set(at(PHASES[0]), at(PHASES[1]), at(PHASES[2]));
    rig.amount.value = 1;
    const before = gl.getRenderTarget();
    gl.setRenderTarget(rig.move);
    s.quads.move.render(gl);
    gl.setRenderTarget(rig.turn);
    s.quads.turn.render(gl);
    gl.setRenderTarget(before);
  });
}
