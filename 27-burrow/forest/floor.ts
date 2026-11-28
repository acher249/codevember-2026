import { dFdx, dFdy, dot, float, Fn, If, mix, mx_noise_float, smoothstep, texture, vec2, vec3, vec4, vertexStage } from "three/tsl";
import type * as THREE from "three/webgpu";
import { COVER, coverTexture } from "./cover";
import { CLEARING } from "./terrain";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The forest floor, for the rock's ground (rock.ts asks for it in place of its own): last year's leaves (Poly Haven's
// Dry Decay Leaves) close by, a darker, mossier floor of old leaves (Forest Leaves 02) in patches and further into the
// trees, a sward of grass where the sun reaches (the cover grid, cover.ts, which the growth is placed by too), moss where
// it is damp along the cliff's foot and in hollows, and bare earth down the trodden way to the face. Seen from above
// (world x and z), its normal map's tilt decoded in world space, as rock.ts does its own ground.
//
// Only worked out where `active` (how much the pixel is open-air ground) is above nothing: everywhere else, the cliff's
// face and every pixel of rock underground, it is skipped by a real branch. Inside the branch the maps are read with
// gradients taken before it (`grad`), as derivatives are only defined outside it.
export type FloorTextures = {
  litter: THREE.Texture;
  litterNormal: THREE.Texture;
  farLitter: THREE.Texture;
  farLitterNormal: THREE.Texture;
  moss: THREE.Texture;
};

// The cover grid (cover.ts) at this point of the floor: read at its top level, which is allowed inside the branch.
// Toward the grid's border it eases to plain woodland (no grass, no path, mostly shaded), so its edge texels are never
// drawn out in stripes across the far floor.
function coverAt(p: any) {
  const at = vec2(p.x.sub(COVER.x0), p.z.sub(COVER.z0)).div(COVER.span) as any;
  const c = texture(coverTexture(), at).level(float(0)) as any;
  const border = at.min(float(1).sub(at)) as any;
  const inside = smoothstep(0, 0.06, border.x.min(border.y)) as any;
  return { grass: c.r.mul(inside), shade: mix(float(0.6), c.g, inside), damp: c.b.mul(inside), path: c.a.mul(inside) };
}

const SCALES = { near: 1 / 1.6, turned: 1 / 2.9, old: 1 / 2.4, moss: 1 / 1.3 };

function layout(p: any, noise: FloorNoise) {
  const fromMiddle = vec2(p.x.sub(CLEARING.x).div(CLEARING.rx), p.z.sub(CLEARING.z).div(CLEARING.rz)).length() as any;
  // Patches metres across of the older, darker floor; more of it out in the trees.
  const patch = smoothstep(-0.25, 0.35, noise.patch.add(smoothstep(0.9, 1.8, fromMiddle).mul(0.5))) as any;
  return { patch };
}

// The floor's noises, all of the ground's plan (x, z) and all slow beside its 20 cm mesh: the slowest a few tens of
// metres across, the quickest (the sward's broken edge) about 0.8 m.
type FloorNoise = { broad: any; mid: any; patch: any; blend: any; sward: any; straw: any; damp: any; worn: any; foot: any };
function floorNoise(p: any): FloorNoise {
  const q = p.xz as any;
  return {
    broad: mx_noise_float(q.mul(0.045).add(31)),
    mid: mx_noise_float(q.mul(0.16).add(57)),
    patch: mx_noise_float(q.mul(0.13)),
    blend: mx_noise_float(q.mul(0.35).add(7)),
    sward: mx_noise_float(q.mul(1.3).add(3)),
    straw: mx_noise_float(q.mul(0.16).add(vec2(-4, 9))),
    damp: mx_noise_float(q.mul(0.45).add(3)),
    worn: mx_noise_float(q.mul(0.9).add(11)),
    foot: mx_noise_float(q.mul(0.7).add(19))
  };
}

// The same noises worked out at the vertices of a fine mesh (the chunks' 20 cm) and carried across its triangles, where
// `near` (per vertex) says the floor could show; nowhere else. Carried linearly over 20 cm they are off by at most 1.2%
// of their range on average (under 7% at worst, near the noise's lattice points; measured against a port of three's
// noise), so the floor looks as it did, and its pixels skip nine of the ten noises that were most of their cost. Not
// for a coarse mesh (the far ground ring keeps them per pixel).
// `extra`: up to four more values to work out per vertex under the same condition (they come back as `extra`).
export function floorNoiseAtVertices(p: any, near: any, extra: any[] = []): { noise: () => FloorNoise; extra: any[] } {
  const packed = (pick: (n: FloorNoise) => any[]) =>
    vertexStage(
      Fn(() => {
        const out = vec4(0).toVar() as any;
        If(near, () => {
          const v = pick(floorNoise(p));
          out.assign(vec4(v[0], v[1] ?? 0, v[2] ?? 0, v[3] ?? 0));
        });
        return out;
      })()
    ) as any;
  const a = packed((n) => [n.broad, n.mid, n.patch, n.blend]);
  const b = packed((n) => [n.straw, n.damp, n.worn, n.foot]);
  const c = extra.length ? packed(() => extra) : null;
  // The sward's broken edge (the quickest, 0.8 m) stays per pixel: it is the floor right in front of the eye.
  return {
    noise: () => ({ broad: a.x, mid: a.y, patch: a.z, blend: a.w, sward: mx_noise_float(p.xz.mul(1.3).add(3)), straw: b.x, damp: b.y, worn: b.z, foot: b.w }),
    extra: c ? [c.x, c.y, c.z, c.w].slice(0, extra.length) : []
  };
}

// A turn of the floor's coordinates, for a second lay of the leaves at another angle.
const turn = (v: any) => vec2(v.x.mul(0.6).sub(v.y.mul(0.8)), v.x.mul(0.8).add(v.y.mul(0.6))) as any;

// `noise`: the floor's noises (floorNoise per pixel, fresh nodes each call, as each branch below needs its own; or
// floorNoiseAtVertices).
export function forestFloorLook(t: FloorTextures, p: any, active: any = float(1), noise: () => FloorNoise = () => floorNoise(p)) {
  const colour = Fn(() => {
    const out = vec3(0).toVar();
    const dx = dFdx(p.xz).toVar();
    const dy = dFdy(p.xz).toVar();
    If(active.greaterThan(0.001), () => {
      const read = (map: THREE.Texture, uv: any, s: number, turned = false) => texture(map, uv).grad(turned ? turn(dx).mul(s) : dx.mul(s), turned ? turn(dy).mul(s) : dy.mul(s)).rgb as any;
      const leaves = read(t.litter, p.xz.mul(SCALES.near), SCALES.near);
      const leaves2 = read(t.litter, turn(p.xz).mul(SCALES.turned), SCALES.turned, true);
      const old = read(t.farLitter, p.xz.mul(SCALES.old), SCALES.old);
      const mossScan = read(t.moss, p.xz.mul(SCALES.moss), SCALES.moss);
      const c = coverAt(p);
      const n = noise();
      const { patch } = layout(p, n);
      // Broad swings of tone and hue tens of metres and a few metres across, so no stretch of floor matches another.
      const broad = n.broad as any;
      const mid = n.mid as any;
      const tone = broad.mul(0.14).add(mid.mul(0.08)).add(1) as any;
      const blend = mix(leaves, leaves2, smoothstep(-0.3, 0.3, n.blend)) as any;
      // Shade-dried leaves, browner than orange, and greyed in drifts where they have lain longest.
      const dry = blend.mul(vec3(0.95, 0.88, 0.78)).mul(0.9) as any;
      const grey = vec3(dot(blend, vec3(0.33))).mul(vec3(0.98, 0.92, 0.84)) as any;
      const leafFloor = mix(dry, grey, smoothstep(-0.1, 0.6, mid).mul(0.4)) as any;
      // Under the crowns, more of the older, darker floor.
      const floor = mix(leafFloor, old.mul(vec3(0.8, 0.84, 0.7)).mul(0.88), patch.mul(0.6).add(c.shade.mul(0.35)).min(0.85)) as any;
      // Turf where the grass grows: the moss scan (about (0.04, 0.095, 0.01) linear on average) recoloured to the
      // grass blades' own greens at their feet, drying to straw in drifts, and broken at its edges so the litter shows
      // through in gaps.
      const sward = smoothstep(0.08, 0.7, c.grass.add(n.sward.mul(0.22))) as any;
      const lum = dot(mossScan, vec3(0.33)) as any;
      const straw = smoothstep(-0.2, 0.55, n.straw) as any;
      const turf = mix(mossScan.mul(vec3(2.5, 1.35, 3.6)), vec3(0.58, 0.52, 0.3).mul(lum.mul(1.3).add(0.25)), straw.mul(0.55)) as any;
      // Moss in the damp along the foot of the cliff and in hollows.
      const damp = smoothstep(0.25, 0.85, c.damp.add(n.damp.mul(0.35))) as any;
      const moss = mossScan.mul(vec3(1.1, 0.95, 1.5)) as any;
      // The trodden way: bare packed earth with a few leaves blown over it.
      const worn = smoothstep(0.1, 0.75, c.path).mul(smoothstep(-0.5, 0.2, n.worn).mul(0.3).add(0.62)) as any;
      const earth = vec3(0.21, 0.16, 0.115).mul(dot(leaves, vec3(0.33)).mul(1.3).add(0.55)) as any;
      // Grit and sand weathered off the face, in a fan along its foot, under the litter there.
      const foot = float(1)
        .sub(smoothstep(0.5, 4.5, p.z))
        .mul(smoothstep(-0.3, 0.3, n.foot.add(0.25))) as any;
      const grit = vec3(0.62, 0.45, 0.31).mul(dot(leaves2, vec3(0.33)).mul(1.5).add(0.45)) as any;
      const ground = mix(mix(mix(mix(floor, turf, sward.mul(0.85)), moss, damp.mul(0.8)), earth, worn), grit, foot.mul(0.6)) as any;
      out.assign(ground.mul(tone));
    });
    return out;
  })() as any;

  const tilt = Fn(() => {
    const out = vec3(0).toVar();
    const dx = dFdx(p.xz).toVar();
    const dy = dFdy(p.xz).toVar();
    If(active.greaterThan(0.001), () => {
      const read = (map: THREE.Texture, s: number) => texture(map, p.xz.mul(s)).grad(dx.mul(s), dy.mul(s)).xyz.mul(2).sub(1) as any;
      const t2 = mix(read(t.litterNormal, SCALES.near), read(t.farLitterNormal, SCALES.old), layout(p, noise()).patch.mul(0.75)) as any;
      // Flatter on the sward and the trodden way than in the loose leaves.
      const c = coverAt(p);
      const flat = float(1).sub(c.grass.mul(0.45)).sub(c.path.mul(0.4)) as any;
      out.assign(vec3(t2.x.mul(1.5), 0, t2.y.mul(1.5)).mul(flat));
    });
    return out;
  })() as any;

  return { colour, tilt };
}
