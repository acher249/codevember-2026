"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { Break, Fn, If, Loop, abs, and, clamp, dot, exp, float, fract, max, min, mix, normalize, pow, screenCoordinate, screenUV, select, smoothstep, texture, texture3D, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import { useQuality } from "../shared/engine/quality";
import { pace } from "./flow";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The sky the bird flies through: clouds raymarched through a slab of air, from a block of baked noise, lit by the sun.
// Each step along a ray finds how dense the cloud is there, how much sunlight reaches it through the cloud between it
// and the sun (Beer–Lambert, two taps), scatters that toward the eye mostly forward (Henyey–Greenstein, two lobes), and
// dims what lies behind it. The whole field slides past at the bird's airspeed, so the clouds stream by.

export type Weather = {
  label: string;
  zenith: string;
  horizon: string;
  below: string;
  sun: [number, number, number];
  sunColour: string;
  sunPower: number;
  ambient: string;
  // The slab of cloud, in metres above and below the bird.
  bottom: number;
  top: number;
  coverage: number;
  density: number;
  // Metres to one repeat of the noise, along x, y and z: unequal for streaks.
  size: [number, number, number];
  detail: number;
  softBottom: number;
  softTop: number;
  speed: number;
  haze: number;
};

export const WEATHER: Record<string, Weather> = {
  cloud: {
    label: "Stormy",
    zenith: "#2f3742",
    horizon: "#59636f",
    below: "#1d2228",
    sun: [0.35, 0.7, 0.62],
    sunColour: "#d9e2ee",
    sunPower: 12,
    ambient: "#262b33",
    bottom: -600,
    top: 400,
    coverage: 0.46,
    density: 0.3,
    size: [600, 420, 600],
    detail: 0.35,
    softBottom: 0.04,
    softTop: 0.4,
    speed: 30,
    haze: 5000,
  },
  // A low sun ahead of the bird, burning through broken cloud.
  sunset: {
    label: "Sunset",
    zenith: "#33416e",
    horizon: "#f08a4b",
    below: "#3e2428",
    sun: [0.6, 0.1, -0.78],
    sunColour: "#ffa860",
    sunPower: 16,
    ambient: "#3a2a2e",
    bottom: -600,
    top: 400,
    coverage: 0.46,
    density: 0.3,
    size: [600, 420, 600],
    detail: 0.35,
    softBottom: 0.04,
    softTop: 0.4,
    speed: 30,
    haze: 5000
  },
  // Clear blue with a high sun and fair-weather cumulus.
  midday: {
    label: "Midday",
    zenith: "#2d6cc2",
    horizon: "#a6c6e8",
    below: "#7890a6",
    sun: [0.2, 0.95, 0.2],
    sunColour: "#fff4e4",
    sunPower: 18,
    ambient: "#4e5e78",
    bottom: -600,
    top: 400,
    coverage: 0.46,
    density: 0.3,
    size: [600, 420, 600],
    detail: 0.35,
    softBottom: 0.04,
    softTop: 0.4,
    speed: 30,
    haze: 5000
  },
  // By moonlight: the same air, nearly black, the cloud edges silvered.
  night: {
    label: "Night",
    zenith: "#04070e",
    horizon: "#18203a",
    below: "#030509",
    sun: [0.3, 0.6, -0.5],
    sunColour: "#a6bce4",
    sunPower: 6,
    ambient: "#0b0f18",
    bottom: -600,
    top: 400,
    coverage: 0.46,
    density: 0.3,
    size: [600, 420, 600],
    detail: 0.35,
    softBottom: 0.04,
    softTop: 0.4,
    speed: 30,
    haze: 5000
  }
};
export const SKIES = Object.entries(WEATHER).map(([value, w]) => ({ value, label: w.label }));

// The noise, baked once: red is Perlin–Worley, rounded billows for the cloud's shape; green is finer Worley, to eat
// wisps out of its edges. It tiles in all three directions.
let baked: THREE.Data3DTexture | null = null;
function cloudNoise() {
  if (baked) return baked;
  const size = 64;
  const data = new Uint8Array(size * size * size * 4);
  const shapes = new Float32Array(size * size * size);
  const fines = new Float32Array(size * size * size);
  const hash = (a: number, b: number, c: number, s: number) => {
    const v = Math.sin(a * 127.1 + b * 311.7 + c * 74.7 + s * 19.3) * 43758.5453;
    return v - Math.floor(v);
  };
  const wrap = (v: number, p: number) => ((v % p) + p) % p;
  const worley = (x: number, y: number, z: number, cells: number, salt: number) => {
    const cx = x * cells;
    const cy = y * cells;
    const cz = z * cells;
    const hx = Math.floor(cx);
    const hy = Math.floor(cy);
    const hz = Math.floor(cz);
    let nearest = 9;
    for (let c = -1; c <= 1; c++)
      for (let b = -1; b <= 1; b++)
        for (let a = -1; a <= 1; a++) {
          const ix = wrap(hx + a, cells);
          const iy = wrap(hy + b, cells);
          const iz = wrap(hz + c, cells);
          const dx = hx + a + hash(ix, iy, iz, salt) - cx;
          const dy = hy + b + hash(iy, iz, ix, salt + 1) - cy;
          const dz = hz + c + hash(iz, ix, iy, salt + 2) - cz;
          nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
        }
    return 1 - Math.min(1, Math.sqrt(nearest));
  };
  const smooth = (x: number, y: number, z: number, period: number, salt: number) => {
    const fx = x * period;
    const fy = y * period;
    const fz = z * period;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const e = (t: number) => t * t * (3 - 2 * t);
    const u = e(fx - x0);
    const v = e(fy - y0);
    const w = e(fz - z0);
    const at = (a: number, b: number, c: number) => hash(wrap(x0 + a, period), wrap(y0 + b, period), wrap(z0 + c, period), salt);
    const near = (at(0, 0, 0) * (1 - u) + at(1, 0, 0) * u) * (1 - v) + (at(0, 1, 0) * (1 - u) + at(1, 1, 0) * u) * v;
    const far = (at(0, 0, 1) * (1 - u) + at(1, 0, 1) * u) * (1 - v) + (at(0, 1, 1) * (1 - u) + at(1, 1, 1) * u) * v;
    return near * (1 - w) + far * w;
  };
  for (let k = 0, o = 0; k < size; k++)
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++, o += 4) {
        const x = i / size;
        const y = j / size;
        const z = k / size;
        let fbm = 0;
        let amplitude = 0.5;
        for (let p = 4; p <= 32; p *= 2) {
          fbm += smooth(x, y, z, p, 3) * amplitude;
          amplitude *= 0.5;
        }
        fbm /= 0.9375;
        const billows = worley(x, y, z, 4, 1) * 0.625 + worley(x, y, z, 8, 5) * 0.25 + worley(x, y, z, 16, 9) * 0.125;
        // Perlin–Worley: the smooth noise, with the cells' rounded billows pressed into it.
        shapes[o / 4] = fbm * 0.55 + billows * 0.45 + fbm * billows;
        fines[o / 4] = worley(x, y, z, 8, 13) * 0.625 + worley(x, y, z, 16, 17) * 0.25 + worley(x, y, z, 32, 21) * 0.125;
        data[o + 2] = fbm * 255;
        data[o + 3] = 255;
      }
  // Stretched to fill the range, from the 2nd to the 98th percentile, so that coverage means what it says.
  const stretch = (values: Float32Array, channel: number) => {
    const sorted = Float32Array.from(values).sort();
    const low = sorted[Math.floor(sorted.length * 0.02)];
    const high = sorted[Math.floor(sorted.length * 0.98)];
    values.forEach((v, i) => (data[i * 4 + channel] = Math.max(0, Math.min(1, (v - low) / (high - low))) * 255));
  };
  stretch(shapes, 0);
  stretch(fines, 1);
  baked = new THREE.Data3DTexture(data, size, size, size);
  baked.format = THREE.RGBAFormat;
  baked.type = THREE.UnsignedByteType;
  baked.minFilter = THREE.LinearFilter;
  baked.magFilter = THREE.LinearFilter;
  baked.wrapS = baked.wrapT = baked.wrapR = THREE.RepeatWrapping;
  baked.needsUpdate = true;
  return baked;
}

// The clouds are drawn at half resolution into a buffer of their own and blended over the frames before, each frame's
// steps starting at a different offset. Any single frame is speckled; over a few they average out smooth. The sky is
// as good as infinitely far, so a pixel's history is found by turning its direction through last frame's camera.
export function CloudSky({ weather }: { weather: string }) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const { tier } = useQuality();
  const steps = tier === "low" ? 36 : tier === "medium" ? 60 : 84;
  const mesh = useRef<THREE.Mesh>(null);
  const u = useMemo(() => {
    const w = WEATHER[weather] ?? WEATHER.cloud;
    return {
      zenith: uniform(new THREE.Color(w.zenith)),
      horizon: uniform(new THREE.Color(w.horizon)),
      below: uniform(new THREE.Color(w.below)),
      sun: uniform(new THREE.Vector3(...w.sun).normalize()),
      sunColour: uniform(new THREE.Color(w.sunColour)),
      sunPower: uniform(w.sunPower),
      ambient: uniform(new THREE.Color(w.ambient)),
      bottom: uniform(w.bottom),
      top: uniform(w.top),
      coverage: uniform(w.coverage),
      density: uniform(w.density),
      scale: uniform(new THREE.Vector3(1 / w.size[0], 1 / w.size[1], 1 / w.size[2])),
      detail: uniform(w.detail),
      softBottom: uniform(w.softBottom),
      softTop: uniform(w.softTop),
      haze: uniform(w.haze),
      travel: uniform(new THREE.Vector3()),
      speed: { current: w.speed }
    };
    // Built once; the weather is eased into the uniforms below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pass = useMemo(() => {
    const targets = [0, 1].map(() => new THREE.RenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false }));
    const view = {
      inverseView: uniform(new THREE.Matrix4()),
      inverseProjection: uniform(new THREE.Matrix4()),
      previous: uniform(new THREE.Matrix4()),
      eye: uniform(new THREE.Vector3()),
      frame: uniform(0),
      blend: uniform(1)
    };
    return { targets, view, count: 0, size: new THREE.Vector2() };
  }, []);

  const material = useMemo(() => {
    const noise = cloudNoise();
    const { view, targets } = pass;
    const m = new THREE.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false });
    // This pixel's direction, from the camera's inverse projection.
    // The buffer's rows run top down, so its v is flipped against clip space.
    const ndc = vec2(uv().x, float(1).sub(uv().y)).mul(2).sub(1) as any;
    const far = view.inverseProjection.mul(vec4(ndc.x, ndc.y, 1, 1)) as any;
    const d = normalize(view.inverseView.mul(vec4(far.xyz.div(far.w), 0)).xyz) as any;

    const skyAt = (dir: any) => {
      const up = dir.y as any;
      const air = mix(u.horizon, u.zenith, pow(clamp(up, 0, 1), 0.45));
      const ground = mix(air, u.below, smoothstep(0.0, -0.25, up));
      const c = max(dot(dir, u.sun), 0) as any;
      const glow = u.sunColour.mul(pow(c, 12).mul(0.12).add(pow(c, 200).mul(0.9)));
      const disc = u.sunColour.mul(smoothstep(0.99955, 0.9998, c).mul(u.sunPower).mul(6));
      return ground.add(glow).add(disc);
    };

    // The cloud's density at a point: the billows, shaped by height in the slab, with coverage deciding how much of
    // the noise is cloud, and finer cells worn out of the edges.
    const shapeAt = (p: any) => {
      const q = p.mul(u.scale);
      const h = clamp(p.y.sub(u.bottom).div(u.top.sub(u.bottom)), 0, 1) as any;
      const profile = smoothstep(0, u.softBottom, h).mul(smoothstep(1, u.softTop, h));
      const base = (texture3D(noise, q) as any).r.mul(profile);
      return clamp(base.sub(float(1).sub(u.coverage)).div(u.coverage), 0, 1) as any;
    };

    const march = Fn(() => {
      const origin = vec3(view.eye.x, view.eye.y.sub(1), view.eye.z).add(u.travel) as any;
      const dy = select(abs(d.y).lessThan(1e-4), float(1e-4), d.y) as any;
      const t0 = u.bottom.sub(origin.y).div(dy);
      const t1 = u.top.sub(origin.y).div(dy);
      const enter = max(min(t0, t1), 0) as any;
      // Beyond a few kilometres the haze has taken everything; marching no further keeps the steps short.
      const leave = min(max(t0, t1), enter.add(3800)) as any;
      const span = max(leave.sub(enter), 0) as any;
      // Interleaved gradient noise, moved on by the golden ratio each frame: each pixel starts its steps somewhere new
      // every frame, and the history averages them.
      const jitter = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189).add(view.frame.mul(0.618034))) as any;
      const light = vec3(0).toVar();
      const through = float(1).toVar();
      // Henyey–Greenstein, a strong forward lobe and a soft back one: clouds blaze round the sun and glow away from it.
      const cosine = dot(d, u.sun) as any;
      const hg = (g: number) => float(1 - g * g).div(pow(float(1 + g * g).sub(cosine.mul(2 * g)), 1.5)).mul(1 / (4 * Math.PI));
      const phase = mix(hg(-0.2), hg(0.75), 0.6).mul(4 * Math.PI) as any;

      If(span.greaterThan(0), () => {
        Loop(steps, ({ i }: any) => {
          If(through.lessThan(0.02), () => {
            Break();
          });
          // Steps closer together near the eye, where the clouds rush past, and wider far off.
          const s = float(i).add(jitter).div(steps);
          const s1 = float(i).add(jitter).add(1).div(steps);
          const t = enter.add(span.mul(s.mul(s)));
          const dt = span.mul(s1.mul(s1).sub(s.mul(s)));
          const p = origin.add(d.mul(t)) as any;
          const shape = shapeAt(p);
          If(shape.greaterThan(0.001), () => {
            // Fine cells worn out of the edges, then a firm edge: billows with clear outlines, not a fog.
            const fine = (texture3D(noise, p.mul(u.scale).mul(6.1)) as any).g;
            const eroded = shape.sub(float(1).sub(fine).mul(u.detail).mul(float(1).sub(shape).mul(0.7).add(0.3)));
            const dense = smoothstep(0.0, 0.18, eroded).mul(u.density) as any;
            // Sunlight reaching this point through the cloud on the way: two taps toward the sun.
            const toward = shapeAt(p.add(u.sun.mul(24))).mul(24).add(shapeAt(p.add(u.sun.mul(90))).mul(66)).mul(u.density) as any;
            const sunlit = exp(toward.mul(-1.1)).add(exp(toward.mul(-0.25)).mul(0.25)) as any;
            const powder = float(1).sub(exp(dense.mul(-90)).mul(0.5));
            const h = clamp(p.y.sub(u.bottom).div(u.top.sub(u.bottom)), 0, 1);
            const lit = u.sunColour.mul(sunlit.mul(phase).mul(powder).mul(u.sunPower).mul(0.07)).add(u.ambient.mul(h.mul(0.45).add(0.35)));
            // Far off, the air between softens it into the horizon.
            const seen = mix(u.horizon, lit, exp(t.div(u.haze).negate()));
            const fade = exp(dense.mul(dt).negate()) as any;
            light.addAssign(seen.mul(through).mul(float(1).sub(fade)));
            through.mulAssign(fade);
          });
        });
      });
      return skyAt(d).mul(through).add(light);
    });
    const current = march() as any;
    const clip = view.previous.mul(vec4(d, 0)) as any;
    const ahead = clip.xy.div(clip.w).mul(0.5).add(0.5) as any;
    const back = vec2(ahead.x, float(1).sub(ahead.y)) as any;
    const kept = and(clip.w.greaterThan(0), and(back.x.greaterThan(0), and(back.x.lessThan(1), and(back.y.greaterThan(0), back.y.lessThan(1)))));
    const history = texture(targets[0].texture, back);
    m.colorNode = vec4(mix(history.rgb, current, select(kept, view.blend, float(1))), 1) as any;
    const quad = new THREE.QuadMesh(m);
    // The dome shows the latest frame of the blended clouds.
    const dome = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const latest = texture(targets[1].texture, screenUV);
    dome.colorNode = latest.rgb as any;
    return { m, quad, dome, history, latest };
  }, [steps, u, pass]);

  useEffect(
    () => () => {
      material.m.dispose();
      material.dome.dispose();
    },
    [material]
  );
  useEffect(() => () => pass.targets.forEach((t) => t.dispose()), [pass]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    mesh.current?.position.copy(camera.position);
    const w = WEATHER[weather] ?? WEATHER.cloud;
    const k = Math.min(1, delta * 1.6);
    u.zenith.value.lerp(new THREE.Color(w.zenith), k);
    u.horizon.value.lerp(new THREE.Color(w.horizon), k);
    u.below.value.lerp(new THREE.Color(w.below), k);
    u.sunColour.value.lerp(new THREE.Color(w.sunColour), k);
    u.ambient.value.lerp(new THREE.Color(w.ambient), k);
    u.sun.value.lerp(new THREE.Vector3(...w.sun).normalize(), k).normalize();
    u.scale.value.lerp(new THREE.Vector3(1 / w.size[0], 1 / w.size[1], 1 / w.size[2]), k);
    for (const key of ["sunPower", "bottom", "top", "coverage", "density", "detail", "softBottom", "softTop", "haze"] as const) u[key].value += (w[key] - u[key].value) * k;
    u.speed.current += (w.speed - u.speed.current) * k;
    // Render this frame's clouds over the last, into the other buffer, and show it.
    gl.getDrawingBufferSize(pass.size);
    const w2 = Math.max(2, Math.floor(pass.size.x / 2));
    const h2 = Math.max(2, Math.floor(pass.size.y / 2));
    const resized = pass.targets[0].width !== w2 || pass.targets[0].height !== h2;
    if (resized) pass.targets.forEach((t) => t.setSize(w2, h2));
    const { view } = pass;
    camera.updateMatrixWorld();
    view.inverseView.value.copy(camera.matrixWorld);
    view.inverseProjection.value.copy(camera.projectionMatrixInverse);
    view.eye.value.copy(camera.position);
    view.blend.value = resized || pass.count === 0 ? 1 : 0.14;
    view.frame.value = pass.count % 64;
    const read = pass.targets[pass.count % 2];
    const write = pass.targets[(pass.count + 1) % 2];
    material.history.value = read.texture;
    material.latest.value = write.texture;
    const before = gl.getRenderTarget();
    gl.setRenderTarget(write);
    material.quad.render(gl);
    gl.setRenderTarget(before);
    view.previous.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    pass.count++;

    // Flying forward, toward +z: the air and its clouds go by the other way. Kept within one repeat of the noise.
    u.travel.value.z = (u.travel.value.z + u.speed.current * delta * pace.current) % 100000;
    u.travel.value.x = Math.sin(u.travel.value.z * 0.0004) * 40;
  });

  return (
    <mesh ref={mesh} material={material.dome} renderOrder={-10} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[50, 64, 32]} />
    </mesh>
  );
}
