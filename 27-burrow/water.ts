import * as THREE from "three/webgpu";
import { cavernDistance, cavernsNear, cliffDepth, galleryCentre, type Cavern, type Rock } from "./field";

// Water (and molten rock) laid in the caverns as they are dressed (dressing.tsx): shaped to the cavern it lies in and
// held by the real rock round it. Pure arithmetic over the field, so it can be checked away from the page.

const UP = new THREE.Vector3(0, 1, 0);

// A sheet of water or molten rock shaped to its cavern's floor: quads (each four corners, two per side of a strip) with
// per-corner data (the flow's direction across x and z, the bank from -1 to 1, metres downstream of the fall).
export type Sheet = { corners: THREE.Vector3[]; data: number[][] }[];
// A river's fall: its lip, its foot (in the water, or on the floor), how it stands (across the passage, thrown out
// from the rock) and its size.
export type Fall = { foot: THREE.Vector3; lip: THREE.Vector3; turn: THREE.Quaternion; width: number; height: number; wet: boolean };
// What water needs to lie in the real rock (every cavern, every dig): air at its surface with a floor close under it, or
// rock (where it runs on under a wall, out of sight). Water placed from one cavern's own walls alone once ran on as a
// flat sheet through whatever else was there: through the air of a neighbouring hall, hanging in mid-air.
type Field = Pick<Rock, "sample">;
export function holds(rock: Field, x: number, level: number, z: number, under: number) {
  return rock.sample(x, level + 0.02, z) > 0 || rock.sample(x, level - under, z) > 0;
}

// The real rock round one cavern, quicker to ask (a few hundred questions per cavern dressed, at 14 µs each through
// the whole field's cell lookups): the cliff and ground, and every cavern near this one, found once. Where a dig has
// reached into that space, the whole rock itself, digs and all.
export function around(c: Cavern, rock: Rock): Field {
  const r = Math.max(...c.size) + (c.axis ? c.size[0] + 4 : 14);
  const [x, y, z] = c.centre;
  for (const e of rock.edits) if (Math.abs(e.x - x) < r + e.r * 1.4 + 0.4 && Math.abs(e.y - y) < r + e.r * 1.4 + 0.4 && Math.abs(e.z - z) < r + e.r * 1.4 + 0.4) return rock;
  const near = cavernsNear(x - r, y - r, z - r, x + r, y + r, z + r, 0, []);
  return {
    sample(px: number, py: number, pz: number) {
      let d = cliffDepth(px, py, pz);
      for (const other of near) d = Math.min(d, cavernDistance(other, px, py, pz));
      return d;
    }
  };
}

// The outline of the water (or molten rock) at `level` round a point: rays out to the cavern's own wall, a little into
// it so no gap shows, each pulled back to where the real rock still holds it. As a fan of quads, rings of corners at
// a third, two thirds and the whole of each ray.
export function pool(field: Rock, rock: Field, centre: THREE.Vector3, level: number, rays: number, under: number): Sheet {
  if (field.sample(centre.x, level + 0.02, centre.z) > 0) return [];
  const reach: number[] = [];
  for (let k = 0; k < rays; k++) {
    const a = (k / rays) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const wall = field.march(centre.x, level + 0.02, centre.z, dx, 0, dz, 12);
    let r = wall >= 0 ? wall + 0.15 : 12;
    // Back from the edge until the whole ray is held (every half metre along it, and its end).
    for (let tries = 0; tries < 6; tries++) {
      let ok = true;
      for (let d = 0.5; d <= r && ok; d += 0.5) ok = holds(rock, centre.x + dx * d, level, centre.z + dz * d, under);
      if (ok && holds(rock, centre.x + dx * r, level, centre.z + dz * r, under)) break;
      r *= 0.7;
    }
    reach.push(r);
  }
  const at = (k: number, f: number) => {
    const a = (k / rays) * Math.PI * 2;
    return new THREE.Vector3(centre.x + Math.cos(a) * reach[k % rays] * f, level, centre.z + Math.sin(a) * reach[k % rays] * f);
  };
  const sheet: Sheet = [];
  const rings = [0, 0.4, 0.75, 1];
  for (let k = 0; k < rays; k++)
    for (let j = 0; j < rings.length - 1; j++)
      sheet.push({
        corners: [at(k, rings[j]), at(k, rings[j + 1]), at(k + 1, rings[j]), at(k + 1, rings[j + 1])],
        data: [rings[j], rings[j + 1], rings[j], rings[j + 1]].map((f) => [0, 0, f, 0])
      });
  return sheet;
}

// A river's water: a strip down its winding passage at one level, as wide as the passage is there (out to its own
// walls and a little into them), only where the real rock holds it (water at that level in the passage, with the
// floor close under it), so it sinks out of sight under rock where the passage rises and never crosses into another
// cavern. And its fall, against the passage's far end, from the roof into the water.
export function river(c: Cavern, field: Rock, rock: Field, level: number) {
  const STATIONS = 44;
  const a = c.size[0];
  const at: [number, number, number] = [0, 0, 0];
  const ahead: [number, number, number] = [0, 0, 0];
  const fallT = a * 0.82;
  type Station = { t: number; left: THREE.Vector3; right: THREE.Vector3; flow: THREE.Vector3 } | null;
  const stations: Station[] = [];
  const mid = new THREE.Vector3();
  for (let s = 0; s < STATIONS; s++) {
    const t = -a - 0.5 + (s / (STATIONS - 1)) * (2 * a + 1);
    galleryCentre(c, t, at);
    galleryCentre(c, t + 0.3, ahead);
    const tangent = new THREE.Vector3(ahead[0] - at[0], 0, ahead[2] - at[2]).normalize();
    const side = new THREE.Vector3(-tangent.z, 0, tangent.x);
    mid.set(at[0], level, at[2]);
    if (!(rock.sample(mid.x, level + 0.02, mid.z) < 0 && rock.sample(mid.x, level - 0.55, mid.z) > 0)) {
      stations.push(null);
      continue;
    }
    const bank = (sign: number) => {
      const wall = field.march(mid.x, level + 0.02, mid.z, side.x * sign, 0, side.z * sign, 6);
      let d = wall >= 0 ? wall + 0.12 : 6;
      for (let tries = 0; tries < 5 && !holds(rock, mid.x + side.x * sign * d, level, mid.z + side.z * sign * d, 0.55); tries++) d *= 0.7;
      return mid.clone().addScaledVector(side, sign * d);
    };
    // The water runs away from the fall, down the passage (-t).
    stations.push({ t, left: bank(-1), right: bank(1), flow: tangent.clone().negate() });
  }
  const sheet: Sheet = [];
  for (let s = 0; s < STATIONS - 1; s++) {
    const p = stations[s];
    const q = stations[s + 1];
    if (!p || !q) continue;
    // Held across its middle too (another cavern can open between two stations).
    const inside = [p.left.clone().lerp(q.right, 0.5), p.left.clone().lerp(q.left, 0.5), p.right.clone().lerp(q.right, 0.5)];
    if (inside.some((v) => !holds(rock, v.x, level, v.z, 0.55))) continue;
    const corner = (st: NonNullable<Station>, bankSide: number) => [st.flow.x, st.flow.z, bankSide, fallT - st.t];
    sheet.push({ corners: [p.left, p.right, q.left, q.right], data: [corner(p, -1), corner(p, 1), corner(q, -1), corner(q, 1)] });
  }
  // The fall: up the passage from where it lands to its end wall, and stood a little out from it.
  galleryCentre(c, fallT, at);
  galleryCentre(c, fallT + 0.3, ahead);
  const tangent = new THREE.Vector3(ahead[0] - at[0], 0, ahead[2] - at[2]).normalize();
  const side = new THREE.Vector3(-tangent.z, 0, tangent.x);
  const spot = new THREE.Vector3(at[0], level + 0.8, at[2]);
  const end = field.march(spot.x, spot.y, spot.z, tangent.x, 0, tangent.z, 5);
  if (end > 0.6) spot.addScaledVector(tangent, end - 0.45);
  let fall: Fall | undefined;
  // Into the water if there is water within a few metres back down the passage (the end often rises out of it).
  const inWater = (v: THREE.Vector3) => rock.sample(v.x, level + 0.02, v.z) < 0 && rock.sample(v.x, level - 0.55, v.z) > 0;
  for (let back = 0; back <= 3 && !inWater(spot); back += 0.5) if (inWater(spot.clone().addScaledVector(tangent, -back))) spot.addScaledVector(tangent, -back);
  const wet = inWater(spot);
  const down = field.march(spot.x, level + 0.5, spot.z, 0, -1, 0, 4);
  if (wet || down > 0) {
    const foot = new THREE.Vector3(spot.x, wet ? level : level + 0.5 - down, spot.z);
    // From the roof straight above (its lip a little up inside the rock, so it pours out of a crack, never the air).
    const roof = field.march(foot.x, foot.y + 0.3, foot.z, 0, 1, 0, 8);
    if (roof > 0.5) {
      const height = roof + 0.3 + 0.25;
      const turn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, UP, tangent.clone().negate()));
      fall = { foot, lip: foot.clone().add(new THREE.Vector3(0, height, 0)), turn, width: 1.1 + Math.min(0.6, c.size[1] * 0.2), height, wet };
    }
  }
  // With no fall, no white water at its foot.
  if (!fall) for (const quad of sheet) for (const d of quad.data) d[3] += 50;
  return { level, sheet, fall };
}


// A sheet as a mesh of its own (the lake's, made once), every quad turned to face up.
export function sheetGeometry(sheet: Sheet) {
  const position: number[] = [];
  const data: number[] = [];
  const index: number[] = [];
  const diagonal = new THREE.Vector3();
  const other = new THREE.Vector3();
  for (const quad of sheet) {
    const order = [0, 1, 2, 3];
    // Corners 0, 1, 2, 3 make the faces (0, 1, 2) and (1, 3, 2): up when the diagonals cross that way.
    diagonal.subVectors(quad.corners[3], quad.corners[0]).cross(other.subVectors(quad.corners[2], quad.corners[1]));
    if (diagonal.y < 0) [order[1], order[2]] = [2, 1];
    const base = position.length / 3;
    for (const from of order) {
      position.push(quad.corners[from].x, quad.corners[from].y, quad.corners[from].z);
      data.push(...quad.data[from]);
    }
    index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(position.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geometry.setAttribute("aSheet", new THREE.Float32BufferAttribute(data, 4));
  geometry.setIndex(index);
  return geometry;
}
