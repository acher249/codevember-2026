import * as THREE from "three/webgpu";
import { cavernBound, cavernDistance, cavernsMeet, cavernsNear, CAVERNS, chunkKey, chunkOf, cliffDepth, groundY, Rock, SIZE, VOXEL, type Cavern, type ChunkMesh, type Edit } from "./field";
import type { Packed } from "./dress";

// The rock on the page. It streams: chunks round the visitor are meshed by a pool of workers, nearest first, and those
// left far behind are let go, all but the ones holding a dug opening in the outer face, which stay so a tunnel's mouth
// never closes up from a distance. Every dig is kept for good (field.ts `Rock`), so a chunk meshed again comes back
// exactly as it was left. One for the whole visit.

// How far round the eye chunks are meshed (in chunks), and how much further before they are let go.
const REACH = 4;
const REACH_UP = 4;
const LET_GO = 2;
const SHADOW_EVERY = 0.2;
// The lake is open to the sky down its chimney, dug into or not: anything running into it may be seen from it.
const LAKE = CAVERNS.find((c) => c.kind === "lake") as Cavern;

// Which chunks are drawn, for the plain cliff and ground beyond to hide themselves there (outside.tsx). Wraps every 64
// chunks across (410 m) and 32 up: far further than anything is ever drawn.
export const MASK = { x: 64, y: 32, z: 64 };

// `caves`: for a chunk whose only surfaces can be the walls of caverns (deep in the rock, no dig near), those caverns;
// null for any other. Such a chunk is drawn only while one of them is not sealed (`sealed`).
type Slot = { state: "queued" | "meshing" | "ready"; version: number; mesh: THREE.Mesh | null; cx: number; cy: number; cz: number; caves: Cavern[] | null; reach: Cavern[] };

export class World {
  rock = new Rock();
  group = new THREE.Group();
  material: THREE.Material = new THREE.MeshBasicNodeMaterial();
  slots = new Map<number, Slot>();
  queue: number[] = [];
  workers: Worker[];
  busy: boolean[];
  digs = 0;
  // Which caverns have been broken into.
  opened = new Set<Cavern>();
  // For `sealed`: how many digs and openings each cavern asked about has been checked against, while it stays sealed.
  private seals = new Map<Cavern, { digs: number; opened: number }>();
  // Bumped by anything that may change what is sealed (and so which chunks are drawn), and the count last drawn by.
  private sealVersion = 0;
  private sealedAt = -1;
  private settle = 0;
  // How many meshed chunks are hidden as holding only sealed caverns' walls (for the stats).
  hidden = 0;
  // Pairs of caverns whose air meets, or not (undefined while the dresser works it out), and its answers awaited.
  private meets = new Map<string, boolean | undefined>();
  private answers = new Map<number, (meet: boolean) => void>();
  centre = new THREE.Vector3(Infinity, 0, 0);
  // Called whenever the meshes change (the sun's shadow is then drawn again).
  changed = () => {};
  mask: THREE.Data3DTexture;
  private maskDirty = false;
  private idle: { resolve: () => void; above: number } | null = null;

  // The worker that works out each cavern's dressing (dress-worker.ts), and the answers awaited from it.
  dresser: Worker | null;
  private asks = new Map<number, (packed: Packed | null) => void>();
  private asked = 0;
  // A remesh near the open air asks for the sun's shadow to be drawn again; the deep ones never change it (no sunlight
  // reaches past the face's first few metres). Asked at most every SHADOW_EVERY seconds while chunks stream in.
  private shadowDue = false;
  private shadowAt = -Infinity;

  constructor(workers: Worker[], dresser: Worker | null = null) {
    this.workers = workers;
    this.dresser = dresser;
    if (dresser)
      dresser.onmessage = (event: MessageEvent<{ type: string; id: number; packed: Packed | null; meet?: boolean }>) => {
        if (event.data.type === "meets") {
          this.answers.get(event.data.id)?.(event.data.meet as boolean);
          this.answers.delete(event.data.id);
          this.sealVersion++;
          return;
        }
        const resolve = this.asks.get(event.data.id);
        this.asks.delete(event.data.id);
        resolve?.(event.data.packed);
      };
    this.busy = workers.map(() => false);
    this.group.name = "burrow-rock";
    const data = new Uint8Array(MASK.x * MASK.y * MASK.z);
    this.mask = new THREE.Data3DTexture(data, MASK.x, MASK.y, MASK.z);
    this.mask.format = THREE.RedFormat;
    this.mask.minFilter = this.mask.magFilter = THREE.NearestFilter;
    this.mask.wrapS = this.mask.wrapT = this.mask.wrapR = THREE.RepeatWrapping;
    this.mask.unpackAlignment = 1;
    this.mask.needsUpdate = true;
    workers.forEach((worker, n) => {
      worker.onmessage = (event: MessageEvent<{ type: string; key: number; version: number; mesh: ChunkMesh | null }>) => this.done(n, event.data.key, event.data.version, event.data.mesh);
    });
  }

  // The rock's three materials, which differ only in the lights they take (rock.ts `createRockMaterial`'s `lit`): `open`
  // for untouched outer rock (sun, sky, headlamp), `material` for dug rock and anything near the mouth or the lake (every
  // light), `deep` for rock well inside (the caves' lights, no sun). See `lightsFor`.
  open: THREE.Material = this.material;
  deep: THREE.Material = this.material;
  // One tiny mesh of each kind, out of sight and hidden, for the warm-up to build their pipelines (a chunk may change
  // kind on its first dig, or a torch mounted near it).
  private parked: THREE.Mesh[] = [];
  // Where torches are mounted: the untouched outer rock within a torch's reach takes every light.
  private torchSpots: THREE.Vector3[] = [];

  setMaterial(material: THREE.Material, open = material, deep = material) {
    this.material = material;
    this.open = open;
    this.deep = deep;
    for (const slot of this.slots.values()) if (slot.mesh) slot.mesh.material = this.lightsFor(slot);
    for (const mesh of this.parked) this.group.remove(mesh);
    this.parked = [material, open, deep].map((m) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, -1000, 0, 0.01, -1000, 0, 0, -1000, 0.01]), 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
      geometry.setAttribute("aInfo", new THREE.BufferAttribute(new Float32Array(9), 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
      const mesh = new THREE.Mesh(geometry, m);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    });
  }

  // Which of the three a chunk takes. Untouched rock of the outer surface alone (no dig, no cavern can reach it, every
  // corner within 6 m of the open air, no torch within reach): sun, sky and headlamp; torches only light rock that has
  // been dug, or has one mounted near. Rock whose every corner is more than 6 m in from the open air, and away from the
  // lake (whose chimney's beam comes down from the sky): no sun, which cannot reach so far into the rock (a dug tunnel
  // is 2.4 m high; the sun 46° up). Anything else: every light, as all rock had.
  private lightsFor(slot: Slot) {
    if (this.open === this.material && this.deep === this.material) return this.material;
    const dug = this.rock.byChunk.has(chunkKey(slot.cx, slot.cy, slot.cz));
    const x0 = slot.cx * SIZE;
    const y0 = slot.cy * SIZE;
    const z0 = slot.cz * SIZE;
    let shallow = 0;
    let deep = 0;
    for (let corner = 0; corner < 8; corner++) {
      const d = cliffDepth(x0 + (corner & 1) * SIZE, y0 + ((corner >> 1) & 1) * SIZE, z0 + ((corner >> 2) & 1) * SIZE);
      if (d < 6) shallow++;
      if (d > 6) deep++;
    }
    if (slot.reach.includes(LAKE)) return this.material;
    if (deep === 8) return this.deep;
    // (A cavern sealed inside it is never seen: only an open one, whose torches might light it, needs every light.)
    if (dug || shallow < 8 || slot.reach.some((c) => !this.sealed(c))) return this.material;
    const reach = 11 + SIZE * 0.87;
    for (const t of this.torchSpots) if (Math.hypot(t.x - x0 - SIZE / 2, t.y - y0 - SIZE / 2, t.z - z0 - SIZE / 2) < reach) return this.material;
    return this.open;
  }

  // A torch mounted at `at`: untouched outer rock round it takes every light from now on.
  torchAt(at: THREE.Vector3) {
    this.torchSpots.push(at.clone());
    for (const slot of this.slots.values()) if (slot.mesh && slot.mesh.material === this.open) slot.mesh.material = this.lightsFor(slot);
  }

  private setMask(slot: Slot, on: boolean) {
    const m = (v: number, n: number) => ((v % n) + n) % n;
    this.mask.image.data![m(slot.cx, MASK.x) + MASK.x * (m(slot.cy, MASK.y) + MASK.y * m(slot.cz, MASK.z))] = on ? 255 : 0;
    this.maskDirty = true;
  }

  // Asks for a chunk to be meshed (again), nearest the eye first.
  private want(cx: number, cy: number, cz: number, urgent = false) {
    const key = chunkKey(cx, cy, cz);
    let slot = this.slots.get(key);
    if (!slot) this.slots.set(key, (slot = { state: "queued", version: 0, mesh: null, cx, cy, cz, caves: null, reach: [] }));
    else {
      slot.version++;
      if (slot.state === "meshing") return;
      slot.state = "queued";
    }
    const at = this.queue.indexOf(key);
    if (at >= 0) this.queue.splice(at, 1);
    if (urgent) this.queue.unshift(key);
    else this.queue.push(key);
  }

  private done(n: number, key: number, version: number, chunk: ChunkMesh | null) {
    this.busy[n] = false;
    const slot = this.slots.get(key);
    if (slot) {
      if (version !== slot.version) {
        // Dug again while it was being meshed: once more, at once.
        slot.state = "queued";
        this.queue.unshift(key);
      } else {
        this.place(slot, chunk);
        slot.state = "ready";
        this.setMask(slot, true);
      }
    }
    this.pump();
  }

  // Whether a chunk lies where the sun can reach (its middle within a couple of chunks of the open air).
  private sunlit(slot: Slot) {
    return cliffDepth((slot.cx + 0.5) * SIZE, (slot.cy + 0.5) * SIZE, (slot.cz + 0.5) * SIZE) < SIZE * 2;
  }

  // The caverns whose walls are all a chunk can hold, if that is all: every corner well behind the rock's outer surface
  // (cliffDepth, 2.5 m), and no dig reaching its samples (`Rock.add` lists a dig in every chunk within its reach and
  // three samples more, the mesher's apron included). Otherwise null.
  private hideable(slot: Slot) {
    if (this.rock.byChunk.has(chunkKey(slot.cx, slot.cy, slot.cz))) return null;
    const x0 = slot.cx * SIZE;
    const y0 = slot.cy * SIZE;
    const z0 = slot.cz * SIZE;
    for (let corner = 0; corner < 8; corner++)
      if (cliffDepth(x0 + (corner & 1) * SIZE, y0 + ((corner >> 1) & 1) * SIZE, z0 + ((corner >> 2) & 1) * SIZE) < 2.5) return null;
    return slot.reach;
  }

  // The caverns whose air can reach a chunk at all (its samples, apron included): of those near, by their bound, and a
  // gallery's by the capsule round its axis that cavernDistance itself keeps to (bends, lift and widest within it).
  private reaching(slot: Slot) {
    const x0 = slot.cx * SIZE;
    const y0 = slot.cy * SIZE;
    const z0 = slot.cz * SIZE;
    const apron = VOXEL * 3;
    const half = SIZE * 0.87 + apron;
    const mx = x0 + SIZE / 2;
    const my = y0 + SIZE / 2;
    const mz = z0 + SIZE / 2;
    return cavernsNear(x0 - apron, y0 - apron, z0 - apron, x0 + SIZE + apron, y0 + SIZE + apron, z0 + SIZE + apron, 0, []).filter((c) => {
      const px = mx - c.centre[0];
      const py = my - c.centre[1];
      const pz = mz - c.centre[2];
      if (Math.hypot(px, py, pz) - half > (c.bound ??= cavernBound(c))) return false;
      if (!c.axis) return true;
      const [ux, uy, uz] = c.axis;
      const t = Math.max(-c.size[0], Math.min(c.size[0], px * ux + py * uy + pz * uz));
      return Math.hypot(px - ux * t, py - uy * t, pz - uz * t) - half <= c.size[1] * 1.1 + 4.5;
    });
  }

  // Draws only the chunks something can be seen in: one holding nothing but the walls of sealed caverns is hidden (most
  // of the rock round the eye in the dense layers). Worked out again when a dig, an opening, an answer from the dresser
  // or a new chunk may have changed it.
  private hideSealed(live: boolean) {
    // (Through the engine's warm-up and a little after, every frame: it hides again whatever it unhid for its warm
    // frames.)
    if (!live) this.settle = 10;
    if (this.settle > 0) {
      this.settle--;
      this.sealedAt = -1;
    }
    if (this.sealedAt === this.sealVersion) return;
    this.sealedAt = this.sealVersion;
    this.hidden = 0;
    for (const slot of this.slots.values()) {
      if (!slot.mesh) continue;
      slot.mesh.visible = !slot.caves || slot.caves.some((c) => !this.sealed(c));
      // Outer rock a cavern inside it has now opened onto takes every light.
      if (slot.mesh.material === this.open && slot.reach.some((c) => !this.sealed(c))) slot.mesh.material = this.material;
      if (!slot.mesh.visible) this.hidden++;
    }
  }

  private place(slot: Slot, chunk: ChunkMesh | null) {
    if (this.sunlit(slot)) this.shadowDue = true;
    slot.reach = this.reaching(slot);
    slot.caves = this.hideable(slot);
    this.sealVersion++;
    const old = slot.mesh;
    if (!chunk) {
      if (old) {
        this.group.remove(old);
        old.geometry.dispose();
        slot.mesh = null;
      }
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(chunk.position, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(chunk.normal, 3));
    geometry.setAttribute("aInfo", new THREE.BufferAttribute(chunk.info, 3));
    geometry.setIndex(new THREE.BufferAttribute(chunk.index, 1));
    const centre = new THREE.Vector3((slot.cx + 0.5) * SIZE, (slot.cy + 0.5) * SIZE, (slot.cz + 0.5) * SIZE);
    geometry.boundingSphere = new THREE.Sphere(centre, SIZE * 0.9 + VOXEL * 2);
    geometry.boundingBox = new THREE.Box3(centre.clone().subScalar(SIZE * 0.5 + VOXEL), centre.clone().addScalar(SIZE * 0.5 + VOXEL));
    if (old) {
      const previous = old.geometry;
      old.geometry = geometry;
      previous.dispose();
    } else {
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      slot.mesh = mesh;
    }
    (slot.mesh as THREE.Mesh).material = this.lightsFor(slot);
    // Only rock the sun can reach casts its shadow: near the open air, or dug (a shaft's walls). Deeper chunks, most of
    // them dense with caverns, were drawn into the 4096 map on every redraw for nothing.
    (slot.mesh as THREE.Mesh).castShadow = this.sunlit(slot) || this.rock.byChunk.has(chunkKey(slot.cx, slot.cy, slot.cz));
  }

  // Hands the nearest waiting chunks to idle workers.
  pump() {
    for (let n = 0; n < this.workers.length; n++) {
      if (this.busy[n]) continue;
      const key = this.queue.shift();
      if (key === undefined) break;
      const slot = this.slots.get(key);
      if (!slot || slot.state !== "queued") {
        n--;
        continue;
      }
      slot.state = "meshing";
      this.busy[n] = true;
      this.workers[n].postMessage({ type: "mesh", key, cx: slot.cx, cy: slot.cy, cz: slot.cz, version: slot.version });
    }
    if (this.idle) {
      const { above } = this.idle;
      let left = false;
      for (const slot of this.slots.values()) if (slot.state !== "ready" && slot.cy >= above) left = true;
      if (!left) {
        const { resolve } = this.idle;
        this.idle = null;
        resolve();
      }
    }
  }

  // Keeps the chunks round the eye meshed and lets far ones go. Cheap when the eye has not changed chunk.
  // `live`: whether the engine's warm-up is over (scenePhase).
  follow(eye: THREE.Vector3, live = true) {
    const cx = chunkOf(eye.x);
    const cy = chunkOf(eye.y);
    const cz = chunkOf(eye.z);
    if (cx !== this.centre.x || cy !== this.centre.y || cz !== this.centre.z) {
      this.centre.set(cx, cy, cz);
      const wanted: [number, number, number, number][] = [];
      for (let dx = -REACH; dx <= REACH; dx++)
        for (let dy = -REACH_UP; dy <= REACH_UP; dy++)
          for (let dz = -REACH; dz <= REACH; dz++) {
            // Whole columns above, so the top of the cliff is never cut through by the edge of what is loaded; below,
            // only a ball (the rock under the feet is out of sight, and full of caverns).
            const d = dx * dx + dz * dz + dy * dy * (dy < 0 ? 1 : 0.3);
            if (d > REACH * REACH + 1) continue;
            if (!this.slots.has(chunkKey(cx + dx, cy + dy, cz + dz))) wanted.push([d, cx + dx, cy + dy, cz + dz]);
          }
      wanted.sort((a, b) => a[0] - b[0]);
      for (const [, x, y, z] of wanted) this.want(x, y, z);
      // Let go of what is far behind, unless it holds a dug opening in the outer face.
      const far = REACH + LET_GO;
      for (const [key, slot] of this.slots) {
        if (Math.abs(slot.cx - cx) <= far && Math.abs(slot.cy - cy) <= far && Math.abs(slot.cz - cz) <= far) continue;
        if (this.rock.byChunk.has(key) && this.outer(slot)) continue;
        if (slot.state === "meshing") continue;
        if (slot.mesh) {
          this.group.remove(slot.mesh);
          slot.mesh.geometry.dispose();
        }
        this.setMask(slot, false);
        this.slots.delete(key);
        const at = this.queue.indexOf(key);
        if (at >= 0) this.queue.splice(at, 1);
      }
      // Nearest first, from wherever the eye now is.
      const distance = (key: number) => {
        const s = this.slots.get(key) as Slot;
        return (s.cx - cx) ** 2 + (s.cz - cz) ** 2 + (s.cy - cy) ** 2 * 1.5;
      };
      this.queue.sort((a, b) => distance(a) - distance(b));
    }
    if (this.maskDirty) {
      this.maskDirty = false;
      this.mask.needsUpdate = true;
    }
    this.hideSealed(live);
    const now = performance.now() / 1000;
    if (this.shadowDue && now - this.shadowAt > SHADOW_EVERY) {
      this.shadowDue = false;
      this.shadowAt = now;
      this.changed();
    }
    this.pump();
  }

  // A cavern's dressing, worked out by the dresser (null without one, or for the five made by hand).
  dress(cavern: Cavern) {
    const { dresser } = this;
    if (!dresser || !cavern.cell) return Promise.resolve(null);
    const id = ++this.asked;
    return new Promise<Packed | null>((resolve) => {
      this.asks.set(id, resolve);
      dresser.postMessage({ type: "dress", id, cell: cavern.cell });
    });
  }

  // Whether nothing in a cavern can be seen from anywhere: never broken into, no dig ever came within reach of its walls
  // (lumps and all, with a metre to spare), not near the lake (open to the sky), and its air meets no cavern that is
  // open (`cavernsMeet`; any doubt, or an answer still to come, counts as open). Its things are then not drawn at all,
  // nor the rock that holds only its walls. Once unsealed it stays so; each call checks only what is new since the last.
  sealed(c: Cavern) {
    if (c === LAKE || this.opened.has(c)) return false;
    let seal = this.seals.get(c);
    if (!seal) this.seals.set(c, (seal = { digs: 0, opened: -1 }));
    else if (seal.digs < 0) return false;
    const bound = (c.bound ??= cavernBound(c));
    const [cx, cy, cz] = c.centre;
    const edits = this.rock.edits;
    for (; seal.digs < edits.length; seal.digs++) {
      const e = edits[seal.digs];
      const reach = e.r * 1.35 + 1.3;
      if (Math.hypot(e.x - cx, e.y - cy, e.z - cz) - bound > reach) continue;
      if (cavernDistance(c, e.x, e.y, e.z) < reach) return this.unseal(seal);
    }
    if (seal.opened !== this.opened.size) {
      if (Math.hypot(LAKE.centre[0] - cx, LAKE.centre[1] - cy, LAKE.centre[2] - cz) < bound + Math.max(...LAKE.size) + 2.5) return this.unseal(seal);
      // Whether it runs into each open cavern is asked of the dresser (a few milliseconds a pair); shown meanwhile.
      let pending = false;
      for (const o of this.opened) {
        if (o === LAKE) continue;
        const meet = this.meet(c, o);
        if (meet === true) return this.unseal(seal);
        if (meet === undefined) pending = true;
      }
      if (pending) return false;
      seal.opened = this.opened.size;
    }
    return true;
  }
  // Whether two caverns' air meets (field.ts `cavernsMeet`): known, or asked of the dresser (undefined until it says).
  private meet(a: Cavern, b: Cavern): boolean | undefined {
    const key = `${a.centre}|${b.centre}`;
    if (this.meets.has(key)) return this.meets.get(key) as boolean | undefined;
    // Too far apart for their bounds to overlap: no need to ask.
    const reach = (a.bound ??= cavernBound(a)) + (b.bound ??= cavernBound(b));
    if (Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1], a.centre[2] - b.centre[2]) >= reach) {
      this.meets.set(key, false);
      return false;
    }
    const { dresser } = this;
    if (!dresser) {
      const meet = cavernsMeet(a, b);
      this.meets.set(key, meet);
      return meet;
    }
    this.meets.set(key, undefined);
    const id = ++this.asked;
    this.answers.set(id, (meet) => this.meets.set(key, meet));
    const ref = (c: Cavern) => (c.cell ? { cell: c.cell } : { hand: CAVERNS.indexOf(c) });
    dresser.postMessage({ type: "meets", id, a: ref(a), b: ref(b) });
    return undefined;
  }
  private unseal(seal: { digs: number }) {
    seal.digs = -1;
    return false;
  }

  // Whether a chunk holds part of the rock's outer surface (the face, the plateau or the ground).
  private outer(slot: Slot) {
    const x = (slot.cx + 0.5) * SIZE;
    const y = (slot.cy + 0.5) * SIZE;
    const z = (slot.cz + 0.5) * SIZE;
    return Math.abs(groundY(x, z) - y) < SIZE * 1.2 || Math.abs(this.rock.sample(x, y, z)) < SIZE * 1.2;
  }

  // Resolves once every chunk asked for so far at or above chunk row `above` is meshed: the first view, behind the
  // loader. The rock deep under the feet (dense with caverns, a few seconds of meshing) streams in after.
  settled(above = -Infinity) {
    return new Promise<void>((resolve) => {
      this.idle = { resolve, above };
      this.pump();
    });
  }

  // Carves a ball of air: at once in the page's copy of the field (to walk and aim by), and in every worker, which then
  // mesh the chunks it reached, before anything else. Returns the caverns it broke into for the first time.
  dig(x: number, y: number, z: number, r: number) {
    const edit: Edit = { x, y, z, r, seed: ++this.digs };
    const touched = this.rock.add(edit);
    this.sealVersion++;
    // A chunk the dig reaches is drawn from now on (it is meshed again too; this keeps it drawn meanwhile).
    for (const key of touched) {
      const slot = this.slots.get(key);
      if (!slot) continue;
      slot.caves = null;
      if (slot.mesh && slot.mesh.material !== this.material) slot.mesh.material = this.lightsFor(slot);
    }
    for (const worker of this.workers) worker.postMessage({ type: "edit", edit });
    this.dresser?.postMessage({ type: "edit", edit });
    for (const key of touched) {
      const slot = this.slots.get(key);
      const cx = (key & 1023) - 512;
      const cy = ((key >> 10) & 1023) - 512;
      const cz = ((key >> 20) & 1023) - 512;
      if (slot || (Math.abs(cx - this.centre.x) <= REACH + 1 && Math.abs(cz - this.centre.z) <= REACH + 1)) this.want(cx, cy, cz, true);
    }
    this.pump();
    const broke: Cavern[] = [];
    for (const cavern of cavernsNear(x - r, y - r, z - r, x + r, y + r, z + r, 1, [])) {
      if (this.opened.has(cavern)) continue;
      if (cavernDistance(cavern, x, y, z) < r * 0.9) {
        this.opened.add(cavern);
        broke.push(cavern);
      }
    }
    return broke;
  }
}

let loading: Promise<World> | null = null;

// The world, its workers made once for the page (not in a memo or an effect, which React's development double mount
// would tear down), the chunks round the first view meshed before it resolves.
export function loadWorld(eye: THREE.Vector3) {
  return (loading ??= (async () => {
    const count = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    const workers = Array.from({ length: count }, () => new Worker(new URL("./world-worker.ts", import.meta.url)));
    const world = new World(workers, new Worker(new URL("./dress-worker.ts", import.meta.url)));
    world.follow(eye);
    await world.settled(chunkOf(eye.y) - 1);
    return world;
  })().catch((failure) => {
    loading = null;
    throw failure;
  }));
}
