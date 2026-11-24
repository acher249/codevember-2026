"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  ivec2,
  textureLoad,
  atan,
  bumpMap,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  clamp,
  cos,
  cross,
  Discard,
  dot,
  exp,
  float,
  Fn,
  fract,
  faceDirection,
  frontFacing,
  If,
  length,
  max,
  min,
  mix,
  mx_cell_noise_float,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_float,
  mx_worley_noise_vec2,
  normalize,
  normalWorld,
  normalLocal,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  screenUV,
  select,
  sin,
  smoothstep,
  step,
  texture,
  time,
  transformNormalToView,
  uniform,
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../shared/engine/Post";
import { lehmer } from "../shared/engine/random";
import type { Lava } from "./lava";
import { N, SPAN } from "./lava";
import { type Crust, RELIEF } from "./crust";
import { buildPocket } from "./pocket";
import { sleevePrint, TOP_FROM, TOP_TO } from "./print";
import { mirrored, BREAD, FLAT, LIP, MAX_BITES, PLATE, POCKET, REST, RIM, SHELL, SLEEVE, sleeveProfile, TEETH } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What the shaders read that the scene changes: the bites (x, z, radius, on, in the pocket's frame), how brightly the
// filling glows through them, and the lava's light.
export const magma = {
  bites: uniformArray(
    Array.from({ length: MAX_BITES }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  ),
  inside: uniform(0),
  glow: uniform(0),
  // How high the filling stands inside the pocket, for the cut walls to show it.
  fill: uniform(0.05)
};

// How far inside the pocket's outline a point of its own frame is (positive inside), as outline() on the processor.
const outlineDepth = (p: any) => {
  const hx = POCKET.length / 2 - POCKET.corner;
  const hz = POCKET.width / 2 - POCKET.corner;
  const q = vec2(abs(p.x).sub(hx), abs(p.y).sub(hz)) as any;
  const outside = length(max(q, vec2(0, 0)))
    .add(min(max(q.x, q.y), 0))
    .sub(POCKET.corner) as any;
  return outside.negate();
};

// The pastry's top over a point, as topHeight() on the processor.
const topHeightNode = (depth: any, x: any, z: any) => {
  const lip = 0.014;
  const rise = float(1).sub(exp(max(depth.sub(LIP * 0.3), 0).div(-0.035))) as any;
  const lumps = float(1)
    .add(
      sin(x.mul(13.1).add(0.7))
        .mul(cos(z.mul(11.3).add(0.4)))
        .mul(0.09)
    )
    .add(sin(x.mul(27).add(z.mul(19))).mul(0.06))
    .add(cos(x.mul(41).sub(z.mul(33))).mul(0.04)) as any;
  return float(lip).add(
    float(POCKET.height - lip)
      .mul(rise)
      .mul(lumps)
  );
};

// Called with the scene's depth once the overlay pass exists, so things drawn there hide behind what the scene draws.
// Built again whenever the material it shades is made anew (`material`), and whenever the post stack is rebuilt (a tier
// change): a builder kept from an earlier material would leave the new one unshaded, a default white quad per
// instance added over the frame, which whited the whole screen when Auto stepped down to Low.
function useOverlay(material: THREE.Material, build: (sceneZ: any) => void) {
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        build(perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the builder closes over the memoised objects that come with the material.
    [material]
  );
}

// An additive overlay material that draws nothing until its shading is built: never a bare white quad.
function overlayMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  material.colorNode = vec4(0, 0, 0, 0);
  material.positionNode = vec3(0, -1000, 0);
  return material;
}


// The world to the pocket's own frame, as it rests (placed, turned, lifted and tilted), for the lava's shader.
const toPocketFrame = uniform(
  new THREE.Matrix4()
    .makeTranslation(POCKET.x, 0, POCKET.z)
    .multiply(new THREE.Matrix4().makeRotationY(POCKET.yaw))
    .multiply(new THREE.Matrix4().makeTranslation(0, REST.lift, 0))
    .multiply(new THREE.Matrix4().makeRotationZ(-REST.tilt))
    .invert()
);

// How far inside the nearest bite a point of the pocket (its own x, z) is: negative inside one, as on the processor.
// A bite's radius toward angle a at height y, torn as on the processor (biteRadius in shape.ts).
const biteRadiusNode = (b: any, a: any, y: any) => {
  const dent = sin(a.mul(9).add(b.z.mul(40)))
    .mul(0.5)
    .add(0.5) as any;
  const tear = sin(a.mul(3).add(b.y.mul(17)))
    .mul(0.008)
    .add(sin(a.mul(5).add(b.x.mul(29))).mul(0.005))
    .add(sin(a.mul(13).add(b.x.mul(97)).add(b.z.mul(13))).mul(0.004))
    .add(sin(a.mul(41).add(b.y.mul(131))).mul(0.0012))
    .add(sin(a.mul(71).add(b.z.mul(211))).mul(0.0006)) as any;
  return b.z
    .sub(dent.mul(dent).mul(TEETH * 0.35))
    .sub(tear)
    .add(y.sub(0.05).mul(0.12)) as any;
};
const biteDistance = (p: any, y: any = float(0.02)) => {
  let d: any = float(1);
  for (let k = 0; k < MAX_BITES; k++) {
    const b = magma.bites.element(k) as any;
    const to = p.sub(b.xy) as any;
    const dk = length(to).sub(biteRadiusNode(b, atan(to.y, to.x), y)) as any;
    d = select(b.w.greaterThan(0.5), min(d, dk), d);
  }
  return d;
};

// Glowing rock by its temperature (0 cold to 1 white hot): dull red, orange, yellow, then near white, brightening as the
// fourth power, as hot things do.
export const incandescence = (t: any) => {
  const g = mix(float(0.03), float(0.62), smoothstep(0.4, 1, t)) as any;
  const b = mix(float(0), float(0.24), smoothstep(0.88, 1, t)) as any;
  return vec3(1, g, b).mul(pow(clamp(t, 0, 1), 3).mul(3.2)) as any;
};

// ---------------------------------------------------------------------------------------------------------------
// The paper plate: flat, then a fluted rim; scorched brown to black wherever the lava has lain.

export function Plate({ lava }: { lava: Lava }) {
  const parts = useMemo(() => {
    // The profile from the middle of its top out round the rim and back underneath: pressed paperboard 0.6 mm thick,
    // finished in a thin rolled edge.
    const top: THREE.Vector2[] = [];
    for (let k = 0; k <= 40; k++) {
      const r = (k / 40) * PLATE;
      const t = Math.min(1, Math.max(0, (r - FLAT) / (PLATE - FLAT)));
      top.push(new THREE.Vector2(r, RIM * t * t * (1.6 - 0.6 * t)));
    }
    const lip = [new THREE.Vector2(PLATE + 0.0022, RIM - 0.0006), new THREE.Vector2(PLATE + 0.0026, RIM - 0.0024), new THREE.Vector2(PLATE + 0.0014, RIM - 0.0036)];
    const under = top
      .slice()
      .reverse()
      .map((v) => new THREE.Vector2(Math.max(0, v.x - 0.0012), v.y - 0.0024));
    // Listed from the underside's middle out round the lip and back in over the top: a lathe faces the side to the right
    // of its profile's direction, and listed the other way its top faced down (the plate lit inside out).
    const geometry = new THREE.LatheGeometry([...top, ...lip, ...under].reverse(), 256);
    // Fluting pressed into the rim, as a paper plate's.
    const position = geometry.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < position.count; k++) {
      const x = position.getX(k);
      const z = position.getZ(k);
      const r = Math.hypot(x, z);
      if (r < FLAT + 0.02) continue;
      const a = Math.atan2(z, x);
      const fade = Math.min(1, (r - FLAT - 0.02) / 0.04);
      position.setY(k, position.getY(k) + Math.sin(a * 96) * 0.0016 * fade);
    }
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.82 });
    const p = positionWorld as any;
    const fibres = mx_fractal_noise_float(vec3(p.x.mul(90), p.z.mul(90), 0)).mul(0.025) as any;
    const paper = vec3(0.92, 0.91, 0.88).add(fibres) as any;
    // Read softly (five taps about a cell and a half apart): the heat map is per cell, and read sharply its edge showed
    // as a saw-tooth of scorch just outside the lava's now smooth outline.
    const sc = p.xz.add(SPAN).div(2 * SPAN) as any;
    const e = 1.5 / N;
    const scorch = texture(lava.scorchTexture, sc)
      .r.mul(0.4)
      .add(texture(lava.scorchTexture, sc.add(vec2(e, 0))).r.mul(0.15))
      .add(texture(lava.scorchTexture, sc.sub(vec2(e, 0))).r.mul(0.15))
      .add(texture(lava.scorchTexture, sc.add(vec2(0, e))).r.mul(0.15))
      .add(texture(lava.scorchTexture, sc.sub(vec2(0, e))).r.mul(0.15))
      // Only on the plate's upper face: the map is read by position, and its underside and outer wall below the lava
      // would otherwise show the scorch as a dark saw-tooth under the rim.
      .mul(smoothstep(0.2, 0.6, normalWorld.y)) as any;
    // Scorch spreads a little past where it is worst, as heat does through paper.
    const brown = mix(paper, vec3(0.6, 0.4, 0.2), smoothstep(0.01, 0.3, scorch)) as any;
    const burnt = mix(brown, vec3(0.05, 0.035, 0.025), smoothstep(0.35, 0.85, scorch.add(mx_noise_float(p.mul(60)).mul(0.08)))) as any;
    // A soft contact shadow just outside the lava's edge, from the depth read bilinearly (smooth, as the outline is).
    const cell = p.xz
      .add(SPAN)
      .div((2 * SPAN) / N)
      .sub(0.5) as any;
    const c0 = cell.floor() as any;
    const cf = cell.sub(c0) as any;
    const depthAt = (i: number, j: number) => textureLoad(lava.stateTexture, ivec2(clamp(c0.add(vec2(i, j)), 0, N - 1) as any)).x as any;
    const near = mix(mix(depthAt(0, 0), depthAt(1, 0), cf.x), mix(depthAt(0, 1), depthAt(1, 1), cf.x), cf.y) as any;
    material.colorNode = burnt.mul(float(1).sub(smoothstep(0.00003, 0.0007, near).mul(0.4))) as any;
    material.roughnessNode = mix(float(0.82), float(0.95), smoothstep(0.2, 0.8, scorch));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return { geometry, material, mesh };
  }, [lava]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={mirrored(parts.mesh)} />;
}

// ---------------------------------------------------------------------------------------------------------------
// The pocket and its sleeve, in the pocket's own frame.

export function Pocket({ crust, fine }: { crust: Crust; fine: boolean }) {
  const parts = useMemo(() => {
    const { geometry } = buildPocket(fine);
    const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.95 });
    // The crust's baked surface: its height raises the mesh (real relief, so pits and crags shade and cast shadow), and
    // its slopes light it.
    const surfaceAt = texture(crust.surface, uv()) as any;
    const lift = texture(crust.surface, uv()).level(float(0)).x as any;
    const under0 = float(1).sub(smoothstep(0.004, 0.012, positionGeometry.y)) as any;
    // The underside sat flat in the foil: no relief there.
    // Only where the surface faces up or down: on the steep sides of the seam, relief stretched along the planar map
    // would draw stripes.
    // Torn crust at a bite's edge: flaps lifted or bent a little in or out, more the nearer the tear.
    const tearAt = biteDistance(positionGeometry.xz, positionGeometry.y) as any;
    const flap = smoothstep(0.012, 0.0, tearAt).mul(mx_noise_float(positionGeometry.mul(90)).mul(0.006)) as any;
    const raised = positionGeometry.add(
      normalLocal.mul(
        lift
          .mul(float(1).sub(under0))
          .mul(smoothstep(0.35, 0.75, abs(normalLocal.y)))
          .add(flap)
      )
    ) as any;
    // The relief never lifts the pastry through the sleeve: under it, held below the sleeve's inner top as the mesh is.
    const hold = float(1).sub(smoothstep(SLEEVE.to, SLEEVE.to + 0.012, positionGeometry.x)) as any;
    const innerTop = float(SLEEVE.height - SLEEVE.board - 0.0015).add(float(SLEEVE.tent).mul(max(float(1).sub(abs(raised.z).div(SLEEVE.width / 2 - SLEEVE.corner)), 0))) as any;
    material.positionNode = vec3(raised.x, mix(raised.y, min(raised.y, innerTop), hold), raised.z) as any;
    const p = positionLocal as any;
    // The top crust is bitten further back than the bottom: the cut depends on the height too.
    const cut = biteDistance(p.xz, p.y) as any;
    const under = float(1).sub(smoothstep(0.004, 0.012, positionGeometry.y)) as any;
    const facing = select(normalLocal.y.greaterThan(-0.2), float(1), float(-1)) as any;
    const flatEnough = smoothstep(0.6, 0.92, abs(normalLocal.y)) as any;
    const tilt = vec3(surfaceAt.y, 0, surfaceAt.z).mul(facing).mul(float(1).sub(under)).mul(flatEnough) as any;
    // Flipped on the inner faces: a normal set by hand is not turned for back faces, and the pocket's inside, seen
    // through a bite, was lit as if facing out (a flat grey wall).
    material.normalNode = transformNormalToView(normalize(normalLocal.sub(tilt))).mul(faceDirection) as any;
    const baked = texture(crust.colour, uv()) as any;
    // The underside: darker and a little greasy where it sat on the hot foil.
    const crustColour = mix(baked.rgb, baked.rgb.mul(vec3(0.62, 0.52, 0.4)), under.mul(0.8)) as any;
    // On the steep sides of the seam the top-down map is stretched into streaks: there, a plain dough colour with a
    // little grain of its own instead.
    const steep = float(1).sub(smoothstep(0.55, 0.92, abs(normalLocal.y))) as any;
    // The seam's steep sides take the crust from the side, not stretched down from above (triplanar): along the long
    // sides by x and height, across the ends by z and height. Then the crimp: a browner pressed band with irregular
    // pinches along it.
    const along = texture(crust.colour, vec2(p.x.div(POCKET.length).add(0.5), p.y.mul(3).add(0.3))).rgb as any;
    const across = texture(crust.colour, vec2(p.y.mul(3).add(0.3), p.z.div(POCKET.width).add(0.5))).rgb as any;
    const sideWeight = abs(normalLocal.z).div(abs(normalLocal.x).add(abs(normalLocal.z)).max(0.001)) as any;
    const pinch = sin(
      p.x
        .add(p.z)
        .mul(520)
        .add(mx_noise_float(p.mul(60)).mul(3))
    )
      .mul(0.5)
      .add(0.5) as any;
    const crimp = mix(vec3(0.62, 0.38, 0.17), vec3(0.48, 0.27, 0.1), pinch.mul(0.6)) as any;
    const sideDough = mix(mix(across, along, sideWeight), crimp, 0.45) as any;
    // A bitten edge: the pale soft bread under the thin shell.
    const crumb = vec3(0.95, 0.9, 0.78).mul(mx_noise_float(p.mul(400)).mul(0.08).add(0.95)) as any;
    const tornWidth = mx_noise_float(p.mul(70))
      .mul(0.5)
      .add(0.55)
      .mul(0.011)
      .add(mx_noise_float(vec3(p.x.mul(300), p.y.mul(40), p.z.mul(300))).mul(0.002)) as any;
    const torn = float(1).sub(smoothstep(0, tornWidth, cut)) as any;
    const front = mix(mix(crustColour, sideDough, steep), crumb, torn.mul(torn)) as any;
    // Inside: soft pale bread, warmed by the filling.
    // Inside: the bread coated in the filling that drained past it, hot sauce in smears and pools with melted cheese
    // streaked through it, thickest low down; a cleaner bread on the roof.
    const smear = smoothstep(
      0.15,
      0.55,
      mx_noise_float(p.mul(45)).add(
        float(1)
          .sub(smoothstep(0.0, 0.05, p.y))
          .mul(0.6)
      )
    ) as any;
    const cheesy = smoothstep(0.55, 0.8, mx_noise_float(vec3(p.x.mul(120), p.y.mul(30), p.z.mul(40)))) as any;
    const sauce = mix(vec3(0.42, 0.09, 0.03), vec3(0.75, 0.52, 0.16), cheesy) as any;
    const inside = mix(vec3(0.88, 0.8, 0.64).mul(baked.a.mul(0.1).add(0.9)), sauce, smear) as any;
    material.colorNode = Fn(() => {
      If(cut.lessThan(0), () => Discard());
      return select(frontFacing, front, inside);
    })();
    const glowFrom = float(1).sub(smoothstep(0.0, 0.11, p.y)) as any;
    // The filling's glow through the bite: on the bread round it and inside.
    material.emissiveNode = min(
      select(
        frontFacing,
        vec3(1, 0.6, 0.22)
          .mul(magma.inside)
          .mul(0.05)
          .mul(float(1).sub(smoothstep(0, 0.04, cut))),
        vec3(1, 0.55, 0.2)
          .mul(magma.inside)
          .mul(glowFrom.mul(2.4).add(0.4))
          .add(
            mix(vec3(1.4, 0.45, 0.1), vec3(1.6, 1.0, 0.35), cheesy)
              .mul(smear)
              .mul(magma.inside.min(1))
              .mul(1.4)
          )
      ),
      vec3(3)
    );
    // Matte and floury; a little greasy underneath.
    material.roughnessNode = select(frontFacing, mix(baked.a, float(0.6), under), float(0.95));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // The bites' cut walls: a band round each bite, standing where the pastry was, showing its thickness: the crisp
    // shell, the soft bread under it, the hollow, and the filling. Clipped to the pastry and to later bites.
    const wallGeometry = new THREE.CylinderGeometry(1, 1, 1, 96, 6, true).translate(0, 0.5, 0);
    const walls: THREE.Mesh[] = [];
    const wallMaterials: THREE.Material[] = [];
    for (let k = 0; k < MAX_BITES; k++) {
      const wall = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.95 });
      const b = magma.bites.element(k) as any;
      const g = positionGeometry as any;
      const a = atan(g.z, g.x) as any;
      const radius = biteRadiusNode(b, a, g.y.mul(0.13)).mul(b.w) as any;
      wall.positionNode = vec3(b.x.add(g.x.mul(radius)), g.y.mul(0.13), b.y.add(g.z.mul(radius)));
      const q = positionLocal as any;
      const d = outlineDepth(q.xz) as any;
      // Kept under the crust's relief (its pits go about 4 mm down): a wall reaching the smooth top would stand up as
      // pale spikes wherever the surface dips.
      const top = topHeightNode(d, q.x, q.z).sub(RELIEF * 0.75) as any;
      const bottom = float(0.002).add(float(0.006).mul(float(1).sub(exp(d.div(-0.05))))) as any;
      const fromTop = top.sub(q.y) as any;
      const fromBottom = q.y.sub(bottom) as any;
      // The other bites: this wall goes where a later (or earlier) bite has eaten past it.
      let others: any = float(1);
      for (let j = 0; j < MAX_BITES; j++) {
        if (j === k) continue;
        const o = magma.bites.element(j) as any;
        const to = q.xz.sub(o.xy) as any;
        others = select(o.w.greaterThan(0.5).and(length(to).lessThan(o.z.sub(0.004))), float(0), others);
      }
      const crumbGrain = mx_fractal_noise_float(q.mul(260)) as any;
      // The shell's broken edge: golden like the crust it belongs to, so the cut blends into it rather than outlining it.
      const shell = vec3(0.9, 0.74, 0.48) as any;
      // Torn soft bread: pale and fibrous, pulled into strands across the tear, with pores.
      const fibres = mx_noise_float(vec3(q.x.mul(60), q.y.mul(900), q.z.mul(60))) as any;
      const pores = smoothstep(0.25, 0.08, mx_worley_noise_float(q.mul(500))) as any;
      const bread = vec3(0.95, 0.88, 0.72)
        .mul(crumbGrain.mul(0.1).add(0.93))
        .mul(fibres.mul(0.08).add(0.96))
        .mul(float(1).sub(pores.mul(0.25))) as any;
      // Turned for the back faces: across the bite the cut is seen from inside the band, and lit as facing away it
      // showed as a flat grey wall.
      wall.normalNode = (bumpMap(fibres.mul(0.6).sub(pores), float(1.5)) as any).mul(faceDirection) as any;
      wall.colorNode = Fn(() => {
        If(b.w.lessThan(0.5).or(d.lessThan(0)).or(fromTop.lessThan(0)).or(fromBottom.lessThan(0)).or(others.lessThan(0.5)), () => Discard());
        // Only the pastry's own thickness shows: the top's crisp shell and bread, and the bottom's. Between them is the
        // hollow, left open so the filling inside (drawn by the lava) shows through it, never a flat painted band.
        // The bottom sheet's cut is torn, not sawn: its top edge wanders round the bite, never a straight ledge.
        const tornBottom = float(SHELL).add(
          float(BREAD * 0.5).mul(
            mx_noise_float(vec3(a.mul(11), 0, k * 7.3))
              .mul(0.6)
              .add(0.55)
          )
        ) as any;
        // Only a thin layer of dough under the top's shell shows at the cut, torn unevenly: past it the cavity, coated in
        // the glowing filling, shows through.
        const tornTop = float(SHELL).add(
          float(BREAD * 0.35).mul(
            mx_noise_float(vec3(a.mul(13), 1, k * 3.1))
              .mul(0.6)
              .add(0.6)
          )
        ) as any;
        const hollow = fromTop.greaterThan(tornTop.add(fibres.mul(0.003))).and(fromBottom.greaterThan(tornBottom)) as any;
        If(hollow.and(d.greaterThan(LIP)), () => Discard());
        return select(fromTop.lessThan(SHELL).or(fromBottom.lessThan(SHELL * 0.8)), shell, bread);
      })();
      // The bread nearest the filling glows faintly with it.
      wall.emissiveNode = vec3(0.7, 0.42, 0.14)
        .mul(magma.inside.min(1))
        .mul(
          smoothstep(0, SHELL + BREAD * 0.3, fromTop)
            .mul(0.5)
            .add(0.5)
            .add(smoothstep(SHELL + BREAD * 0.6, SHELL * 0.5, fromBottom).mul(0.9))
        );
      const wallMesh = new THREE.Mesh(wallGeometry, wall);
      wallMesh.frustumCulled = false;
      wallMesh.castShadow = false;
      wallMesh.receiveShadow = true;
      walls.push(wallMesh);
      wallMaterials.push(wall);
    }

    // The sleeve: a card tube with rounded edges round the far end, open at both ends, finger holes in its sides; the
    // print outside, the grey crisping foil inside.
    const sleeve = buildSleeve();
    const print = sleevePrint();
    const sp = positionLocal as any;
    // A vent hole in each side near the open end: cut through, with the board's pale edge showing round it.
    const holeX = SLEEVE.to - 0.075;
    const hole = length(vec2(sp.x.sub(holeX), sp.y.sub(SLEEVE.height * 0.5))) as any;
    const onSide = step(SLEEVE.width / 2 - SLEEVE.corner - 0.004, abs(sp.z)) as any;
    const cutHole = hole.lessThan(0.026).and(onSide.greaterThan(0.5)) as any;
    const holeRim = smoothstep(0.0305, 0.026, hole).mul(onSide) as any;
    const boardEdge = vec3(0.86, 0.82, 0.74).mul(mx_noise_float(sp.mul(900)).mul(0.06).add(0.95)) as any;
    // Outside: the print, the folds a touch darker where the board is creased.
    const printMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
    printMaterial.colorNode = Fn(() => {
      If(cutHole, () => Discard());
      const crease = smoothstep(0.004, 0.0, abs(sp.z)).mul(step(SLEEVE.height * 0.9, sp.y)) as any;
      return mix(texture(print, uv()).rgb.mul(float(1).sub(crease.mul(0.12))), boardEdge, holeRim);
    })();
    // Inside: the grey crisping foil.
    const foilMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.55 });
    foilMaterial.colorNode = Fn(() => {
      If(cutHole, () => Discard());
      return mix(vec3(0.36, 0.36, 0.37).add(mx_noise_float(sp.mul(300)).mul(0.04)), boardEdge, holeRim);
    })();
    // The cut edge of the board at its open ends: pale grey-brown fibre.
    const edgeMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, side: THREE.DoubleSide });
    edgeMaterial.colorNode = boardEdge;
    const sleeveMaterial = [printMaterial, foilMaterial, edgeMaterial];
    const sleeveMesh = new THREE.Mesh(sleeve, sleeveMaterial);
    sleeveMesh.castShadow = true;
    sleeveMesh.receiveShadow = true;

    // Placed and turned on the plate, then tilted back end up and lifted, as it rests (REST, solved in shape.ts).
    const group = new THREE.Group();
    group.position.set(POCKET.x, 0, POCKET.z);
    group.rotation.y = POCKET.yaw;
    const tilted = new THREE.Group();
    tilted.position.y = REST.lift;
    tilted.rotation.z = -REST.tilt;
    tilted.add(mesh, sleeveMesh, ...walls);
    group.add(tilted);
    return { group, geometry, material, sleeve, sleeveMaterial, print, mesh, wallGeometry, wallMaterials };
  }, [crust, fine]);
  useDispose(parts.geometry, parts.material, parts.sleeve, ...parts.sleeveMaterial, parts.print, parts.wallGeometry, ...parts.wallMaterials);
  return <primitive object={mirrored(parts.group)} name="pocket" />;
}

// The sleeve: real paperboard, half a millimetre thick, folded round the pocket. Its outline (shape.ts) is carried along
// the pocket as an outer skin (the print, group 0) and an inner one (the crisping foil, group 1), joined at each open end
// by the board's pale cut edge (group 2). u runs along the sleeve, v round it from the middle of the underside, remapped
// so the top's two panels land on the print's top band.
function buildSleeve() {
  const outer = sleeveProfile();
  const n = outer.length;
  // The inside: each point moved in by the board's thickness, along the outline's inward normal.
  const inner = outer.map(([z, y], k) => {
    const [pz, py] = outer[(k - 1 + n) % n];
    const [nz, ny] = outer[(k + 1) % n];
    const tz = nz - pz;
    const ty = ny - py;
    const len = Math.hypot(tz, ty) || 1;
    // Anticlockwise round (z, y): the inward normal is the tangent turned left.
    return [z - (ty / len) * SLEEVE.board, y + (tz / len) * SLEEVE.board] as [number, number];
  });
  const lengths = [0];
  for (let k = 1; k < n; k++) lengths.push(lengths[k - 1] + Math.hypot(outer[k][0] - outer[k - 1][0], outer[k][1] - outer[k - 1][1]));
  const total = lengths[n - 1];
  const w = SLEEVE.width / 2;
  const topStart = lengths[outer.findIndex(([z, y]) => z > 0 && y >= SLEEVE.height - 1e-6 && z <= w - SLEEVE.corner + 1e-6)] / total;
  const topEnd = lengths[outer.findIndex(([z, y]) => z < 0 && y >= SLEEVE.height - 1e-6 && z >= -w + SLEEVE.corner - 1e-6)] / total;
  const remap = (v: number) =>
    v < topStart ? (v / topStart) * TOP_FROM : v > topEnd ? TOP_TO + ((v - topEnd) / (1 - topEnd)) * (1 - TOP_TO) : TOP_FROM + ((v - topStart) / (topEnd - topStart)) * (TOP_TO - TOP_FROM);
  const ALONG = 32;
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const geometry = new THREE.BufferGeometry();
  const sheet = (ring: [number, number][], flip: boolean) => {
    const start = positions.length / 3;
    for (let a = 0; a <= ALONG; a++) {
      const t = a / ALONG;
      const x = SLEEVE.from + t * (SLEEVE.to - SLEEVE.from);
      for (let k = 0; k < n; k++) {
        positions.push(x, ring[k][1], ring[k][0]);
        uvs.push(t, remap(lengths[k] / total));
      }
    }
    const first = index.length;
    for (let a = 0; a < ALONG; a++) {
      for (let k = 0; k < n - 1; k++) {
        const i0 = start + a * n + k;
        const i1 = start + (a + 1) * n + k;
        if (flip) index.push(i0, i0 + 1, i1, i0 + 1, i1 + 1, i1);
        else index.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1);
      }
    }
    return [first, index.length - first];
  };
  const [o0, oCount] = sheet(outer, false);
  const [i0, iCount] = sheet(inner, true);
  // The cut edges at both ends: a thin strip from the outside to the inside.
  const rimFirst = index.length;
  for (const end of [0, ALONG]) {
    const x = SLEEVE.from + (end / ALONG) * (SLEEVE.to - SLEEVE.from);
    const start = positions.length / 3;
    for (let k = 0; k < n; k++) {
      positions.push(x, outer[k][1], outer[k][0], x, inner[k][1], inner[k][0]);
      uvs.push(0, 0, 0, 0);
    }
    for (let k = 0; k < n - 1; k++) {
      const a = start + k * 2;
      if (end === 0) index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      else index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.addGroup(o0, oCount, 0);
  geometry.addGroup(i0, iCount, 1);
  geometry.addGroup(rimFirst, index.length - rimFirst, 2);
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------------------------------------------------------
// The lava: the grid drawn as a mesh, each vertex on a cell's middle, raised by its depth; incandescent where hot, a
// dark wrinkled crust as it cools, cracking to show the glow beneath.

export function LavaSurface({ lava, fine }: { lava: Lava; fine: boolean }) {
  const parts = useMemo(() => {
    const dx = (2 * SPAN) / N;
    const size = (N - 1) * dx;
    // Twice the cells' resolution where the tier allows: the surface between cell centres is read bilinearly, so the
    // extra vertices round the lip instead of stepping it.
    const geometry = new THREE.PlaneGeometry(size, size, (N - 1) * (fine ? 2 : 1), (N - 1) * (fine ? 2 : 1)).rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.4 });
    // Cell reads. Bilinear between the four cell centres round a point, so neither the mesh nor the outline steps by cell.
    const load = (tex: THREE.Texture, ij: any) => textureLoad(tex, ivec2(clamp(ij, 0, N - 1) as any)) as any;
    const cellOf = (xz: any) => xz.add(SPAN).div(dx).sub(0.5) as any;
    const bilinear = (tex: THREE.Texture, xz: any) => {
      const c = cellOf(xz);
      const i0 = c.floor() as any;
      const f = c.sub(i0) as any;
      return mix(mix(load(tex, i0), load(tex, i0.add(vec2(1, 0))), f.x), mix(load(tex, i0.add(vec2(0, 1))), load(tex, i0.add(vec2(1, 1))), f.x), f.y) as any;
    };
    // The surface's height per cell (floor plus the rounded lip's raise, shownRaise() in lava.ts) comes worked out.
    const g = positionGeometry.xz as any;
    const here = bilinear(lava.stateTexture, g);
    const ground = bilinear(lava.surfaceTexture, g);
    const h = here.x as any;
    // Folds: as the skin cools it buckles into ropes across the flow, a little real relief.
    const flowHere = here.zw as any;
    const dirHere = flowHere.div(max(length(flowHere), 0.0001)).add(vec2(0, 1e-6)) as any;
    const coolHere = smoothstep(0.75, 0.4, here.y) as any;
    const fold = sin(
      dot(g, dirHere)
        .mul(300)
        .add(mx_noise_float(vec3(g.mul(22), 0)).mul(9))
    )
      .mul(coolHere)
      .mul(smoothstep(0.005, 0.014, h))
      // Only where it is moving: still lava has no direction, and folds laid by a direction that flips from cell to cell
      // stand up as spikes.
      .mul(smoothstep(0.01, 0.05, length(flowHere)))
      .mul(0.0009) as any;
    const y = ground.x.add(0.0011).add(fold) as any;
    // Only the grid round the lava is drawn: a vertex with no lava within a cell of it (diagonals too) goes to one point
    // far below, so the dry part of the grid folds to nothing and never runs the lava's shading.
    const cell = cellOf(g).round() as any;
    let near: any = h;
    for (const [ox, oz] of [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [0, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1]
    ])
      near = max(near, load(lava.stateTexture, cell.add(vec2(ox, oz))).x);
    material.positionNode = select(near.greaterThan(0.0006), vec3(g.x, y, g.y), vec3(0, -2, 0));
    // The normal per pixel, not per vertex: central differences a cell either side of the pixel, of the surface read
    // bilinearly. Continuous across cells and triangles alike, so the lip shades as a smooth curve, with no facets and
    // no bands a cell apart.
    const surfaceAt = (xz: any) => bilinear(lava.surfaceTexture, xz).x as any;
    const w = positionWorld.xz as any;
    const worldNormal = normalize(vec3(surfaceAt(w.sub(vec2(dx, 0))).sub(surfaceAt(w.add(vec2(dx, 0)))), float(2 * dx), surfaceAt(w.sub(vec2(0, dx))).sub(surfaceAt(w.add(vec2(0, dx)))))) as any;
    // Depth and heat per pixel too: interpolated across the triangles, the thin edge's skin and the contact sheen
    // followed the facets and drew dark teeth up the lip.
    const pixel = bilinear(lava.stateTexture, positionWorld.xz) as any;
    const vh = pixel.x as any;
    const vt = pixel.y as any;
    const vflow = pixel.zw as any;

    // The skin: rope-like wrinkles across the flow (pāhoehoe), drifting with it, and cells of crust split by glowing
    // cracks. Two layers carried along the flow and crossfaded, so the pattern moves without stretching forever.
    const p = positionWorld.xz as any;
    const speed = length(vflow) as any;
    const along = vflow.div(max(speed, 0.0001)).add(vec2(0, 1e-6)) as any;
    // The ropes drift with the flow, two phases crossfaded; one noise each.
    const skin = (phase: any) => {
      const q = p.sub(vflow.mul(phase.mul(0.6))) as any;
      const wave = dot(q, along)
        .mul(300)
        .add(mx_noise_float(vec3(q.mul(22), 0)).mul(5)) as any;
      return { rope: sin(wave), slope: cos(wave) };
    };
    const t1 = fract(time.mul(0.15)) as any;
    const t2 = fract(time.mul(0.15).add(0.5)) as any;
    const a = skin(t1);
    const b = skin(t2);
    const fade = abs(t1.mul(2).sub(1)) as any;
    // Patterns laid out on the plate's plane stretch into vertical stripes up the lip's steep wall: there, and at the
    // thin edge, the ropes and cracks fade out and the lip is plain glossy lava.
    const level = smoothstep(0.55, 0.85, worldNormal.y).mul(smoothstep(0.0012, 0.005, vh)) as any;
    const rope = mix(a.rope, b.rope, fade).mul(level) as any;
    const slope = mix(a.slope, b.slope, fade).mul(level) as any;
    // Cracks meander where a noise crosses zero, broken up by a second, so they never tile into cells. Worked out once,
    // not per phase: the crust they split barely moves.
    // The crust breaks into irregular plates: cell edges of a warped cell noise, so they never read as a honeycomb.
    const n = mx_fractal_noise_float(vec3(p.mul(26), 0.5)) as any;
    const warped = p.add(vec2(n, mx_noise_float(vec3(p.mul(19), 7.5))).mul(0.018)) as any;
    const plates = mx_worley_noise_vec2(vec3(warped.mul(52), 0)) as any;
    const breaks = smoothstep(0.0, 0.35, mx_noise_float(vec3(p.mul(14), 2.5)).add(0.15)) as any;
    const crack = float(1)
      .sub(smoothstep(0, 0.07, plates.y.sub(plates.x)))
      .mul(breaks)
      .mul(level) as any;
    const t = clamp(vt, 0, 1) as any;
    // Molten, glossy and hot through most of it; a thin dark skin only where it has cooled, at its thin edges and its
    // coolest patches, split by glowing cracks.
    const cooled = smoothstep(0.5, 0.22, t.add(mx_noise_float(vec3(p.mul(30), 4)).mul(0.08))).mul(0.85) as any;
    const thinEdge = smoothstep(0.003, 0.0009, vh).mul(smoothstep(0.85, 0.5, t)) as any;
    // Cold through: the skin goes on darkening, from a brown-red crust to near-black rock.
    const cold = smoothstep(0.2, 0.03, t) as any;
    const crusted = max(cooled.add(cold.mul(0.13)), thinEdge.mul(0.25)) as any;
    // Ropes stand on the molten surface too (pahoehoe), sharper as the skin stiffens; only where it is moving.
    const wrinkle = float(0.2)
      .add(crusted.mul(0.3))
      .mul(smoothstep(0, 0.02, speed).mul(0.7).add(0.3)) as any;
    const tilt = vec3(along.x, 0, along.y).mul(slope.mul(wrinkle).mul(0.55)) as any;
    material.normalNode = transformNormalToView(normalize(worldNormal.sub(tilt)));
    // Inside the pocket (seen through a bite): the filling, sauce with strands of cheese and bits of pepperoni.
    const vInside = varying(ground.y) as any;
    // Melted cheese in long pulled strands through the sauce, and a few discs of pepperoni.
    const strands = smoothstep(
      0.45,
      0.85,
      sin(
        dot(p, vec2(along.y.negate(), along.x))
          .mul(90)
          .add(mx_noise_float(vec3(p.mul(25), 1)).mul(5))
      )
    ) as any;
    const cheese = strands.mul(smoothstep(0.3, 0.6, mx_noise_float(vec3(p.mul(14), 6)))) as any;
    const pepperoni = smoothstep(0.22, 0.12, mx_worley_noise_float(vec3(p.mul(30), 9))).mul(step(0.55, mx_cell_noise_float(vec3(p.mul(30), 9).floor()))) as any;
    // The filling is only drawn inside a bite, cut at the bite's own scalloped edge: grid cells would cut it in steps,
    // and the steps stand up as spikes of filling round the bite.
    const local = toPocketFrame.mul(vec4(positionWorld, 1)).xyz as any;
    const intoBite = biteDistance(local.xz).negate() as any;
    // The filling's look comes on smoothly with depth into the bite's opening, not cell by cell, so the filling and
    // the lava pouring out of it are one surface with no stepped seam between them.
    const fillingLook = vInside.mul(smoothstep(0.03, 0.09, intoBite)).mul(0.6) as any;
    material.colorNode = Fn(() => {
      // The outline from the depth read per pixel and blended bilinearly between the four cells round it, not as the
      // triangles interpolate it: a bilinear field's contour is a smooth curve, the triangles' a fine zigzag.
      const hb = vh;
      // Never under the pocket: inside its footprint (the rounded outline, read analytically so it follows the curved
      // corners, not the grid) the lava is drawn only through the bite. Under the leaning pocket there is an open gap,
      // and the cavity's filling drawn there stood as curtains and slivers seen from low beside it.
      If(hb.lessThan(0.0007).or(outlineDepth(local.xz).greaterThan(-0.004).and(intoBite.lessThan(0))), () => Discard());
      // Nor under the plate: out on the open plate, the edge's last triangles slope down from a wet cell to a dry one
      // below the plate's floor, and showed from low through the gap under the plate as orange teeth on the counter.
      const r = positionWorld.xz.length() as any;
      const t = clamp(r.sub(FLAT).div(PLATE - FLAT), 0, 1) as any;
      const plateTop = t.mul(t).mul(float(1.6).sub(t.mul(0.6))).mul(RIM) as any;
      If(outlineDepth(local.xz).lessThan(-0.004).and(positionWorld.y.lessThan(plateTop.sub(0.0004))), () => Discard());
      // Nor as a curtain: down the side of a pizza roll the floor drops several centimetres in a cell or two, and the lava
      // on top joined to the pool below by a sheet hung there, toothed cell by cell. Out on the plate nothing else is so
      // steep: the lava shows on the roll and round its foot, the roll's own side between.
      If(outlineDepth(local.xz).lessThan(-0.004).and(worldNormal.y.lessThan(0.42)), () => Discard());
      // Fresh skin: a dark red-brown crust, then as it goes cold, near-black glassy rock; a little lighter on the crests
      // of the ropes.
      const basalt = mix(vec3(0.13, 0.05, 0.025), vec3(0.032, 0.028, 0.026), cold).add(rope.mul(0.008)).mul(n.mul(0.3).add(0.85)) as any;
      const molten = vec3(0.3, 0.06, 0.015) as any;
      const filling = mix(mix(vec3(0.3, 0.07, 0.02), vec3(0.5, 0.32, 0.08), cheese), vec3(0.22, 0.04, 0.02), pepperoni) as any;
      return mix(mix(molten, basalt, crusted), filling, fillingLook);
    })();
    // Wet and glossy where molten, a satin skin where cooled.
    // A thin wet sheen right at the contact with the plate.
    const contact = smoothstep(0.003, 0.0008, vh) as any;
    material.roughnessNode = mix(mix(float(0.1), mix(float(0.5), float(0.62), cold), crusted), float(0.06), contact).add(rope.mul(0.03));
    const open = float(1).sub(crusted) as any;
    // The cracks glow from the hotter lava under the skin, the deeper the hotter.
    const under = clamp(t.add(0.3).add(vh.mul(3)), 0, 0.85) as any;
    const cracks = crack.mul(crusted).mul(smoothstep(0.12, 0.4, t)) as any;
    // Hot lava churns: its glow wanders in slow cells, as the surface turns over, and the ropes' crests run hotter.
    const churn = mx_noise_float(vec3(p.mul(16), time.mul(0.35)))
      .mul(0.3)
      .add(0.85) as any;
    const crest = rope.mul(0.07).add(1) as any;
    // The filling glows in its own colours: sauce deep orange-red, cheese a brighter yellow, pepperoni dull and dark.
    const fillingGlow = mix(mix(vec3(0.85, 0.42, 0.14), vec3(1.15, 1.0, 0.6), cheese), vec3(0.55, 0.2, 0.07), pepperoni) as any;
    const glow = incandescence(t.mul(0.82))
      .mul(open.mul(0.8).add(0.2))
      .mul(churn)
      .mul(crest)
      .add(
        vec3(0.16, 0.035, 0.005)
          .mul(crusted)
          .mul(smoothstep(0.05, 0.3, t))
      ) as any;
    // The filling glows from its own heat (kept hot inside the pocket), not dimmed like the open flow's skin.
    // Red-heavy glow is tone-mapped to salmon pink: the filling glows orange to yellow instead.
    const insideGlow = incandescence(max(t, 0.82)).mul(fillingGlow).mul(churn).mul(0.85) as any;
    material.emissiveNode = min(mix(glow, insideGlow, fillingLook).add(incandescence(under).mul(cracks).mul(0.9)), vec3(5));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    // No shadow: the shadow pass ignores the outline's discard, so it would cast the triangles round the edge as a
    // saw-tooth on the plate. The contact darkening under the lip comes from the occlusion pass instead.
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    return { geometry, material, mesh };
  }, [lava]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={mirrored(parts.mesh)} name="lava-mesh" />;
}

// ---------------------------------------------------------------------------------------------------------------
// Crumbs knocked off by a bite, or by a roll landing: little flakes of pastry that fall, bounce and settle on the plate or the lava.

export type Crumbs = {
  mesh: THREE.InstancedMesh;
  spawn: (x: number, y: number, z: number, count: number) => void;
  clear: () => void;
  update: (dt: number, floor: (x: number, z: number) => number) => void;
};

export function useCrumbs(): Crumbs {
  return useMemo(() => {
    // Room for a bite's and a batch of rolls' landing (two to four each) at once.
    const COUNT = 128;
    const geometry = new THREE.IcosahedronGeometry(1, 0).scale(1, 0.55, 0.8);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
    const shade = attribute("aShade", "float") as any;
    material.colorNode = mix(vec3(0.94, 0.82, 0.58), vec3(0.72, 0.45, 0.2), shade);
    const shades = new Float32Array(COUNT);
    const random = lehmer(77);
    for (let k = 0; k < COUNT; k++) shades[k] = random();
    geometry.setAttribute("aShade", new THREE.InstancedBufferAttribute(shades, 1));
    const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    const live = Array.from({ length: COUNT }, () => ({ on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), spin: new THREE.Vector3(), turn: new THREE.Euler(), size: 0, rest: false }));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let k = 0; k < COUNT; k++) mesh.setMatrixAt(k, hidden);
    let next = 0;
    return {
      mesh,
      spawn(x, y, z, count) {
        for (let n = 0; n < count; n++) {
          const c = live[next++ % COUNT];
          c.on = true;
          c.rest = false;
          c.p.set(x + (random() - 0.5) * 0.12, y + random() * 0.03, z + (random() - 0.5) * 0.16);
          c.v.set((random() - 0.3) * 0.5, random() * 0.4, (random() - 0.5) * 0.5);
          c.spin.set(random() * 20, random() * 20, random() * 20);
          c.size = 0.0016 + random() * random() * 0.0045;
        }
      },
      clear() {
        for (let k = 0; k < COUNT; k++) {
          live[k].on = false;
          mesh.setMatrixAt(k, hidden);
        }
        mesh.instanceMatrix.needsUpdate = true;
      },
      update(dt, floor) {
        for (let k = 0; k < COUNT; k++) {
          const c = live[k];
          if (!c.on) continue;
          if (!c.rest) {
            c.v.y -= 9.8 * 4 * dt;
            c.p.addScaledVector(c.v, dt);
            c.turn.x += c.spin.x * dt;
            c.turn.y += c.spin.y * dt;
            c.turn.z += c.spin.z * dt;
            const ground = floor(c.p.x, c.p.z) + c.size * 0.5;
            if (c.p.y < ground) {
              c.p.y = ground;
              if (Math.abs(c.v.y) < 0.25) {
                c.rest = true;
              } else {
                c.v.y *= -0.3;
                c.v.x *= 0.5;
                c.v.z *= 0.5;
                c.spin.multiplyScalar(0.5);
              }
            }
          } else {
            // Resting on lava: carried down into it slowly as it is swallowed.
            const ground = floor(c.p.x, c.p.z) + c.size * 0.5;
            c.p.y += (ground - c.p.y) * Math.min(1, dt * 3);
          }
          q.setFromEuler(c.turn);
          m.compose(c.p, q, new THREE.Vector3(c.size, c.size, c.size));
          mesh.setMatrixAt(k, m);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    };
  }, []);
}

// ---------------------------------------------------------------------------------------------------------------
// Steam and smoke: soft wisps that rise, spread and fade, lit warm by the lava below them. Drawn in the overlay pass.

export type Puffs = { mesh: THREE.InstancedMesh; emit: (x: number, y: number, z: number, kind: number, size: number) => void; update: (dt: number) => void };

export function usePuffs(): Puffs {
  const parts = useMemo(() => {
    const COUNT = 260;
    const quad = new THREE.PlaneGeometry(1, 1);
    const place = new Float32Array(COUNT * 4);
    const look = new Float32Array(COUNT * 4);
    const placeAttribute = new THREE.InstancedBufferAttribute(place, 4).setUsage(THREE.DynamicDrawUsage);
    const lookAttribute = new THREE.InstancedBufferAttribute(look, 4).setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute("aPlace", placeAttribute);
    quad.setAttribute("aLook", lookAttribute);
    const material = overlayMaterial();
    const mesh = new THREE.InstancedMesh(quad, material, COUNT);
    const identity = new THREE.Matrix4();
    for (let k = 0; k < COUNT; k++) mesh.setMatrixAt(k, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    const live = Array.from({ length: COUNT }, () => ({ age: 0, life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), size: 0, kind: 0, seed: 0 }));
    const random = lehmer(4242);
    let next = 0;
    return {
      quad,
      material,
      mesh,
      emit(x: number, y: number, z: number, kind: number, size: number) {
        const w = live[next++ % COUNT];
        w.age = 0;
        w.life = 2.2 + random() * 2.2;
        w.p.set(x, y, z);
        w.v.set((random() - 0.5) * 0.03, 0.06 + random() * 0.06, (random() - 0.5) * 0.03);
        w.size = size * (0.7 + random() * 0.6);
        w.kind = kind;
        w.seed = random();
      },
      update(dt: number) {
        if (!(dt >= 0)) dt = 0;
        for (let k = 0; k < COUNT; k++) {
          const w = live[k];
          if (w.life <= 0 || w.age >= w.life || !Number.isFinite(w.p.x + w.p.y + w.p.z)) {
            w.life = 0;
            look[k * 4] = 0;
            place[k * 4 + 3] = 0;
            continue;
          }
          w.age += dt;
          // Rising, slowing, curling as it goes.
          w.v.y *= Math.exp(-dt * 0.4);
          w.v.x += Math.sin(w.age * 2.3 + w.seed * 20) * 0.01 * dt;
          w.v.z += Math.cos(w.age * 1.9 + w.seed * 30) * 0.01 * dt;
          w.p.addScaledVector(w.v, dt);
          // Never past its end: a negative base to a fractional power is NaN, and bloom smears one NaN over the frame.
          const f = Math.min(1, w.age / w.life);
          place[k * 4] = w.p.x;
          place[k * 4 + 1] = w.p.y;
          place[k * 4 + 2] = w.p.z;
          place[k * 4 + 3] = w.size * (0.4 + f * 1.6);
          // How strong now: in quickly, out slowly.
          look[k * 4] = Math.min(1, w.age * 4) * Math.pow(Math.max(0, 1 - f), 1.6);
          look[k * 4 + 1] = w.kind;
          look[k * 4 + 2] = w.seed;
          look[k * 4 + 3] = f;
        }
        placeAttribute.needsUpdate = true;
        lookAttribute.needsUpdate = true;
      }
    };
  }, []);
  useDispose(parts.quad, parts.material);

  useOverlay(parts.material, (sceneZ) => {
    const s = attribute("aPlace", "vec4") as any;
    const l = attribute("aLook", "vec4") as any;
    const toEye = normalize(cameraPosition.sub(s.xyz).add(vec3(0, 0, 1e-5))) as any;
    // Never normalised from nothing: looked at from straight above, the cross product would be zero.
    const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
    const up = cross(toEye, right) as any;
    // Turned a little over its life, so wisps never look like the same sprite.
    const a = l.z.mul(6.28).add(l.w.mul(1.4)) as any;
    const g = positionGeometry as any;
    const turned = vec2(g.x.mul(cos(a)).sub(g.y.mul(sin(a))), g.x.mul(sin(a)).add(g.y.mul(cos(a)))) as any;
    parts.material.positionNode = s.xyz.add(right.mul(turned.x.mul(s.w))).add(up.mul(turned.y.mul(s.w))) as any;
    const q = uv().sub(0.5) as any;
    const r = length(q) as any;
    const wisp = mx_fractal_noise_float(vec3(q.mul(3.2), l.z.mul(10).add(l.w.mul(0.8))))
      .mul(0.5)
      .add(0.55) as any;
    const shape = float(1)
      .sub(smoothstep(0.1, 0.5, r))
      .mul(clamp(wisp, 0, 1)) as any;
    const hidden = step(sceneZ, positionView.z) as any;
    // Steam is pale, warm where the lava lights it from below; smoke (kind 1) is a dimmer grey-brown.
    const fromLava = exp(s.y.mul(-14)) as any;
    const steam = mix(vec3(0.16, 0.15, 0.14), vec3(0.55, 0.22, 0.07), fromLava.mul(magma.glow.min(1))) as any;
    const smoke = vec3(0.07, 0.06, 0.05) as any;
    const tint = mix(steam, smoke, l.y) as any;
    parts.material.colorNode = vec4(
      clamp(
        tint
          .mul(shape)
          .mul(clamp(l.x, 0, 1))
          .mul(hidden)
          .mul(0.09),
        0,
        0.2
      ) as any,
      1
    ) as any;
    parts.material.needsUpdate = true;
  });
  return parts;
}

// The lava's light, set each frame from where the hot lava is and how much: inside the pocket through the bite, and out
// on the plate.
export function useLavaLight(lava: Lava, light: () => THREE.PointLight | null) {
  useFrame(() => {
    const l = light();
    if (!l) return;
    const g = lava.glow;
    const amount = Math.min(3, g.amount * 0.6 + (lava.bites.length ? Math.min(1, g.inside * 0.15) : 0));
    // The light and the glow uniform only ever take finite values.
    l.intensity = Number.isFinite(amount) ? Math.min(0.38, Math.max(0, amount * 0.18)) : 0;
    // Held well above the lava, so it lights the pastry and plate round it evenly rather than scorching one spot.
    l.position.set(g.amount > 0.02 ? g.x : POCKET.x, (g.amount > 0.02 ? g.y : 0.04) + 0.4, g.amount > 0.02 ? g.z : POCKET.z);
    magma.glow.value = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  });
}
