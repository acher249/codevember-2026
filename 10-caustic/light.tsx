"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, dFdx, dFdy, dot, float, length, max, min, positionWorld, refract, smoothstep, sqrt, step, texture, uniform, uv, varying, vec2, vec3, vec4 } from "three/tsl";
import { useGrabbable } from "../shared/engine/controls";
import { useQuality } from "../shared/engine/quality";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Caustics after Evan Wallace: light is a mesh. Each vertex of a grid held square to the sun is one ray, traced through
// the glass or water in its vertex shader to where it lands. Where rays crowd together their triangles shrink, so a
// triangle's area before over its area after is how bright the light is there. Every triangle is added into one map
// of the floor seen from above, and whatever light falls on reads it back.

// The sun: `dir` points at it, `across` and `up` span the grid its rays start from.
export const sun = {
  dir: uniform(new THREE.Vector3(0, 1, 0)),
  across: uniform(new THREE.Vector3(1, 0, 0)),
  up: uniform(new THREE.Vector3(0, 0, 1)),
  colour: uniform(new THREE.Color("#fff1dc")),
  power: uniform(3)
};

// How many frames everything that throws light has been still. While it moves, or just after, the light is worked out
// again each frame; once all is still, the map from the last frame is kept, which is most of the cost of the scene saved.
export const stillness = { frames: 0 };
export const stir = () => {
  stillness.frames = 0;
};
const STILL_ENOUGH = 3;
export const lightIsStill = () => stillness.frames > STILL_ENOUGH;

// The square of floor the map covers.
export const field = { centre: uniform(new THREE.Vector2()), size: uniform(5) };

const MAP_SIZE = 2048;
const map = () => new THREE.RenderTarget(MAP_SIZE, MAP_SIZE, { type: THREE.HalfFloatType, depthBuffer: false });
export const causticTarget = map();
// The map softened, in two passes of a Gaussian, across then down. How soft, in metres, is up to the study: real light
// through glass is never perfectly crisp, as the sun is not a point and no edge is perfectly sharp.
const halfSoft = map();
const softTarget = map();
export const soften = uniform(0.004);

function blurPass(source: THREE.RenderTarget, across: boolean) {
  const material = new THREE.MeshBasicNodeMaterial();
  const reach = soften.div(field.size).div(6) as any;
  let sum: any = vec3(0, 0, 0);
  let total = 0;
  for (let i = -6; i <= 6; i++) {
    const w = Math.exp(-(i * i) / 18);
    total += w;
    const offset = reach.mul(i);
    sum = sum.add(texture(source.texture, uv().add(across ? vec2(offset, 0) : vec2(0, offset))).rgb.mul(w));
  }
  material.colorNode = vec4(sum.div(total), 1);
  return new THREE.QuadMesh(material);
}
const blurAcross = blurPass(causticTarget, true);
const blurDown = blurPass(halfSoft, false);
const causticScene = new THREE.Scene();

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

// Points the sun from its height above the horizon and its bearing, both in degrees.
export function aimSun(elevation: number, azimuth: number) {
  const e = THREE.MathUtils.degToRad(elevation);
  const a = THREE.MathUtils.degToRad(azimuth);
  const dir = sun.dir.value.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
  const across = sun.across.value.crossVectors(dir, Math.abs(dir.y) > 0.98 ? X : Y).normalize();
  sun.up.value.crossVectors(across, dir).normalize();
}

// Where on the map a point of the world is, and the caustic light that fell there. It fades out at the map's edge.
export function causticAt(p: any) {
  const q = p.xz.sub(field.centre).div(field.size) as any;
  const st = vec2(q.x.add(0.5), q.y.add(0.5));
  const inside = smoothstep(0.5, 0.44, max(abs(q.x), abs(q.y)));
  return texture(softTarget.texture, st).rgb.mul(inside) as any;
}

// The light a surface of this albedo gives back from the caustics, matched to what the sun gives a lambertian surface.
export function causticLight(albedo: any, at: any = positionWorld) {
  return causticAt(at).mul(albedo).mul(sun.colour).mul(sun.power).mul(1 / Math.PI) as any;
}

// Ray helpers, for tracers. Directions are unit length.
export const roots = (b: any, k: any, a: any = float(1)) => {
  const h = b.mul(b).sub(a.mul(k)) as any;
  const s = sqrt(max(h, 0)) as any;
  return { near: b.negate().sub(s).div(a) as any, far: b.negate().add(s).div(a) as any, hit: step(0, h) as any };
};
export const sphereRoots = (o: any, d: any, c: any, r: any) => {
  const oc = o.sub(c) as any;
  return roots(dot(oc, d), dot(oc, oc).sub(float(r).mul(r)));
};
// 1 where refraction went through, 0 where it was totally reflected and refract() gave nothing.
export const through = (v: any) => step(0.5, length(v)) as any;
// Bends a ray at a surface. The normal faces the side the ray comes from; eta is the index it leaves over the one it enters.
export const bend = (d: any, n: any, eta: any) => refract(d, n, eta) as any;
// Carries a ray on to a horizontal plane, and says whether it gets there.
export const toLevel = (o: any, d: any, y: any) => {
  const t = float(y).sub(o.y).div(min(d.y, -1e-4)) as any;
  return { at: o.add(d.mul(t)) as any, ok: step(d.y, -1e-4).mul(step(0, t)) as any };
};
// A landing, kept to a sane distance so that a stray ray cannot stretch a triangle across the world.
export const landing = (p: any, weight: any) => vec4(p.x.clamp(-40, 40), p.y, p.z.clamp(-40, 40), weight);

export type Band = { spread: number; colour: [number, number, number] };
// A tracer gives back where a ray lands and how much of it gets there, as (x, y, z, weight), or that and a colour it picked up.
export type Tracer = (origin: any, dir: any, spread: any, band: number) => any;

export const WHITE: Band[] = [{ spread: 0, colour: [1, 1, 1] }];

// Light split by colour: each band bends by a little more than the one before, and the bands add up to white.
export function spectrum(count: number, amount: number): Band[] {
  if (count === 3) {
    return [
      { spread: -amount * 0.8, colour: [1, 0, 0] },
      { spread: 0, colour: [0, 1, 0] },
      { spread: amount, colour: [0, 0, 1] }
    ];
  }
  const raw = Array.from({ length: count }, (_, i) => {
    const hue = (i / (count - 1)) * 0.75;
    const c = new THREE.Color().setHSL(hue, 1, 0.5);
    return [c.r, c.g, c.b] as [number, number, number];
  });
  const sums = [0, 1, 2].map((k) => raw.reduce((s, c) => s + c[k], 0));
  return raw.map((c, i) => ({ spread: -amount + (2 * amount * i) / (count - 1), colour: [c[0] / sums[0], c[1] / sums[1], c[2] / sums[2]] as [number, number, number] }));
}

// One scene's light: a grid of rays `span` wide (or [wide, tall]) around `centre`, traced by `trace` for each band.
// `limit` caps how bright a focus can get, so a perfect point does not blow up to infinity.
export function Caustics({
  trace,
  centre,
  span,
  bands = WHITE,
  detail = 384,
  strength = 1,
  limit = 60,
  fixed = false,
  quiet = false
}: {
  trace: Tracer;
  centre: any;
  span: number | [number, number];
  bands?: Band[];
  detail?: number;
  strength?: number;
  limit?: number;
  // A small grid, held close around one object, keeps its full detail on every tier: it is cheap, and thinning it shows.
  fixed?: boolean;
  // Built and drawn, but adding no light: for building its shaders ahead of time.
  quiet?: boolean;
}) {
  const { tier } = useQuality();
  const lines = Math.round((detail * (fixed || tier === "high" ? 1 : tier === "medium" ? 0.8 : 0.6)) / Math.sqrt(bands.length));
  const [wide, tall] = typeof span === "number" ? [span, span] : span;

  // How much of its light it adds, as a uniform, so that a quiet one builds the very same shader as a loud one.
  const gain = useMemo(() => uniform(1), []);
  gain.value = quiet ? 0 : 1;

  const meshes = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1, lines, Math.max(2, Math.round((lines * tall) / wide)));
    return bands.map((band, index) => {
      const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const size = vec2(wide, tall);
      const g = uv().sub(0.5).mul(size) as any;
      const origin = centre.add(sun.dir.mul(30)).add(sun.across.mul(g.x)).add(sun.up.mul(g.y));
      const traced = trace(origin, sun.dir.negate(), float(band.spread), index);
      const hit = traced.hit ?? traced;
      const tint = traced.tint ? (varying(traced.tint) as any) : vec3(1, 1, 1);
      material.positionNode = hit.xyz;
      const landed = varying(hit) as any;
      const before = uv().mul(size) as any;
      const cross2 = (a: any, b: any) => abs(a.x.mul(b.y).sub(a.y.mul(b.x)));
      const areaBefore = cross2(dFdx(before), dFdy(before));
      const areaAfter = cross2(dFdx(landed.xz), dFdy(landed.xz));
      const bright = min(areaBefore.div(max(areaAfter, 1e-9)), limit).mul(landed.w).mul(strength).mul(gain) as any;
      material.colorNode = vec4(vec3(...band.colour).mul(tint).mul(bright), 1);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      return mesh;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace, lines, wide, tall, bands, strength, limit, gain]);

  useEffect(() => {
    stir();
    meshes.forEach((mesh) => causticScene.add(mesh));
    return () => {
      stir();
      meshes.forEach((mesh) => {
        causticScene.remove(mesh);
        (mesh.material as THREE.Material).dispose();
      });
      meshes[0]?.geometry.dispose();
    };
  }, [meshes]);

  return null;
}

// The map's detail on each tier. Three of them at full size on a phone is most of its memory and much of its time.
const MAP_SIZES = { low: 768, medium: 1280, high: 2048 };

// Draws every scene's light into the map, before the frame.
export function CausticPass() {
  const { tier } = useQuality();
  useEffect(() => {
    const size = MAP_SIZES[tier];
    [causticTarget, halfSoft, softTarget].forEach((target) => target.setSize(size, size));
    stir();
  }, [tier]);
  const camera = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 200), []);
  const clear = useMemo(() => new THREE.Color() as THREE.Color & { a: number }, []);
  useFrame(({ gl }) => {
    if (lightIsStill()) return;
    const renderer = gl as unknown as THREE.WebGPURenderer;
    const half = field.size.value / 2;
    const { x, y } = field.centre.value;
    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    camera.position.set(x, 100, y);
    camera.up.set(0, 0, -1);
    camera.lookAt(x, 0, y);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const before = renderer.getRenderTarget();
    renderer.getClearColor(clear);
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(causticTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    if (causticScene.children.length) renderer.render(causticScene, camera);
    renderer.setRenderTarget(halfSoft);
    blurAcross.render(renderer);
    renderer.setRenderTarget(softTarget);
    blurDown.render(renderer);
    renderer.setRenderTarget(before);
    renderer.setClearColor(clear, alpha);
  });
  return null;
}

// The sun as a light: shadows sharp enough for the caustics to fill them.
// `follow`, if given, is read every frame instead, for a sun that is dragged about. `pool` narrows the sun to a soft
// spot that wide, from just as far away, so the rest of the room falls into the dark.
export function Sun({
  elevation,
  azimuth,
  power = 3,
  colour = "#fff1dc",
  direct = true,
  reach = 4,
  follow,
  pool
}: {
  elevation: number;
  azimuth: number;
  power?: number;
  colour?: string;
  direct?: boolean;
  reach?: number;
  follow?: { current: { elevation: number; azimuth: number } };
  pool?: number;
}) {
  const { tier } = useQuality();
  const light = useMemo(() => {
    const l = pool ? new THREE.SpotLight("#ffffff", 1, 0, Math.atan(pool / 12), 0.65, 0) : new THREE.DirectionalLight();
    l.castShadow = true;
    l.shadow.bias = -0.0003;
    l.shadow.normalBias = 0.01;
    l.shadow.radius = 1.5;
    return l;
  }, [pool]);

  useEffect(() => {
    const size = tier === "low" ? 1024 : 2048;
    light.shadow.mapSize.set(size, size);
    light.shadow.map?.dispose();
    light.shadow.map = null;
  }, [light, tier]);

  useFrame(() => {
    const before = sun.dir.value.clone();
    aimSun(follow?.current.elevation ?? elevation, follow?.current.azimuth ?? azimuth);
    if (before.distanceToSquared(sun.dir.value) > 1e-10) stir();
    sun.colour.value.set(colour);
    sun.power.value = power;
    light.color.set(colour);
    light.intensity = direct ? power : 0;
    const c = field.centre.value;
    light.target.position.set(c.x, 0, c.y);
    light.position.copy(light.target.position).addScaledVector(sun.dir.value, 12);
    light.target.updateMatrixWorld();
    const cam = light.shadow.camera as THREE.OrthographicCamera;
    if (cam.isOrthographicCamera) {
      cam.left = cam.bottom = -reach;
      cam.right = cam.top = reach;
    }
    cam.near = 6;
    cam.far = 20;
    cam.updateProjectionMatrix();
  });

  useEffect(() => () => light.dispose(), [light]);

  return (
    <>
      <primitive object={light} />
      <primitive object={light.target} />
    </>
  );
}

// Lets a thing be picked up and slid around at a fixed height: the drag point is put back on that level.
export function useSlide({
  pick,
  height,
  onGrab,
  onMove,
  onRelease
}: {
  pick: (ray: THREE.Ray) => { distance: number; point: THREE.Vector3 } | null;
  height: () => number;
  onGrab?: (point: THREE.Vector3) => void;
  onMove: (point: THREE.Vector3) => void;
  onRelease?: (velocity: THREE.Vector3) => void;
}) {
  const camera = useThree((state) => state.camera);
  const scratch = useMemo(() => ({ ray: new THREE.Ray(), plane: new THREE.Plane(), point: new THREE.Vector3() }), []);
  const level = (point: THREE.Vector3) => {
    scratch.ray.origin.copy(camera.position);
    scratch.ray.direction.copy(point).sub(camera.position).normalize();
    scratch.plane.set(Y, -height());
    return scratch.ray.intersectPlane(scratch.plane, scratch.point);
  };
  useGrabbable({
    pick,
    grab: (point) => {
      const p = level(point);
      if (p) onGrab?.(p);
    },
    drag: (point) => {
      const p = level(point);
      if (p) onMove(p);
    },
    release: (velocity) => onRelease?.(velocity)
  });
}
