"use client";

// A 90s teen's bedroom at night, out of focus behind the toy: a desk under it, a desk lamp to the left pouring warm
// light across, a lava lamp glowing on the right, glow-in-the-dark stars stuck over the wall, a string of fairy lights,
// posters, cassettes. All of it far enough back to melt into the lens blur. Then the air in front: the lamp's beam
// showing, dust turning in it, and soft bokeh discs from every light in the room. Built once at load.

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  color,
  cross,
  dot,
  exp,
  float,
  Fn,
  fract,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionLocal,
  positionView,
  positionWorld,
  screenUV,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Centimetres. The toy hangs at the origin; the desk is under it, the wall well behind.
export const DESK_Y = -21;
const WALL_Z = -175;
// The lamp's bulb, off to the left and a little in front, and where its light falls.
export const LAMP: [number, number, number] = [-34, 16, 18];
const LAMP_SEEN: [number, number, number] = [-78, -6, -60];
const LAVA: [number, number, number] = [58, DESK_Y, -95];
const WARM = new THREE.Color("#ffc285");

// The posters: abstract, loud, our own: squiggles, zigzags, dots and triangles on flat colour.
function poster(seed: number, ground: string, inks: string[]) {
  const c = document.createElement("canvas");
  c.width = 384;
  c.height = 512;
  const g = c.getContext("2d")!;
  const random = lehmer(seed);
  g.fillStyle = ground;
  g.fillRect(0, 0, 384, 512);
  for (let k = 0; k < 26; k++) {
    g.fillStyle = g.strokeStyle = inks[k % inks.length];
    g.lineWidth = 8 + random() * 14;
    g.lineCap = "round";
    const x = random() * 384;
    const y = random() * 512;
    const kind = k % 4;
    if (kind === 0) {
      g.beginPath();
      for (let s = 0; s < 6; s++) g.lineTo(x + s * 22, y + (s % 2 ? 22 : -22));
      g.stroke();
    } else if (kind === 1) {
      g.beginPath();
      g.arc(x, y, 12 + random() * 40, 0, Math.PI * 2);
      g.fill();
    } else if (kind === 2) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 70, y + 20);
      g.lineTo(x + 20, y + 80);
      g.closePath();
      g.fill();
    } else {
      g.beginPath();
      for (let s = 0; s < 40; s++) g.lineTo(x + s * 4, y + Math.sin(s * 0.45) * 18);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Where every light in the room sits, for the bokeh: [x, y, z, r, g, b, strength, size].
type Glow = [number, number, number, number, number, number, number, number];

export function Bedroom() {
  const parts = useMemo(() => {
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const textures: THREE.Texture[] = [];
    const glows: Glow[] = [];
    const random = lehmer(2491);
    const plain = (hex: string, roughness = 0.8, emissive?: string, glow = 0) => {
      const m = new THREE.MeshStandardNodeMaterial({ color: hex, roughness });
      if (emissive) m.emissiveNode = color(emissive).mul(glow) as any;
      materials.push(m);
      return m;
    };
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, at: [number, number, number], shadow = false) => {
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...at);
      mesh.receiveShadow = true;
      mesh.castShadow = shadow;
      group.add(mesh);
      return mesh;
    };

    // The wall: dusky painted plaster, a soft mottle in it.
    const wall = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
    wall.colorNode = mix(color("#241d2b"), color("#342b3c"), mx_fractal_noise_float(positionWorld.mul(0.012), 3, 2, 0.5).mul(0.5).add(0.5)) as any;
    materials.push(wall);
    add(new THREE.PlaneGeometry(700, 420), wall, [0, 60, WALL_Z]);
    // Side wall to the right, in shadow, and a ceiling.
    const side = add(new THREE.PlaneGeometry(400, 420), wall, [190, 60, -20]);
    side.rotation.y = -Math.PI / 2;
    const ceiling = add(new THREE.PlaneGeometry(700, 400), plain("#2a2430", 0.95), [0, 160, -20]);
    ceiling.rotation.x = Math.PI / 2;

    // The desk: dark varnished wood under the toy, reaching back to the wall.
    const desk = new THREE.MeshStandardNodeMaterial({ roughness: 0.45 });
    {
      const p = positionWorld as any;
      const grain = sin(p.x.mul(0.35).add(mx_noise_float(p.mul(vec3(0.02, 0.1, 0.3))).mul(6))).mul(0.5).add(0.5) as any;
      desk.colorNode = mix(color("#2c1a12"), color("#5a3622"), grain.mul(0.6).add(mx_noise_float(p.mul(0.05)).mul(0.25))) as any;
      desk.roughnessNode = float(0.38).add(grain.mul(0.15)) as any;
    }
    materials.push(desk);
    const top = add(new THREE.BoxGeometry(260, 3, 210), desk, [0, DESK_Y - 1.5, -70]);
    top.castShadow = false;

    // Cassettes stacked on the desk, a pencil cup, a scrunchie of a torus; dim shapes in the blur.
    const tapeColours = ["#e8e2d4", "#1d1d22", "#ff5f8f", "#3fb6c9", "#f2c94c"];
    for (let k = 0; k < 6; k++) {
      const tape = add(new THREE.BoxGeometry(10.8, 1.6, 7), plain(tapeColours[k % tapeColours.length], 0.35), [-58 + random() * 3, DESK_Y + 0.8 + k * 1.6, -75 + random() * 3], true);
      tape.rotation.y = (random() - 0.5) * 0.5;
    }
    add(new THREE.CylinderGeometry(4, 3.6, 11, 24, 1, true), plain("#7a5cff", 0.4), [30, DESK_Y + 5.5, -55], true);
    for (let k = 0; k < 7; k++) {
      const pencil = add(new THREE.CylinderGeometry(0.45, 0.45, 17, 6), plain(["#f2c94c", "#ff6f61", "#56cc9d"][k % 3], 0.5), [30 + (random() - 0.5) * 4, DESK_Y + 11, -55 + (random() - 0.5) * 4]);
      pencil.rotation.set((random() - 0.5) * 0.4, 0, (random() - 0.5) * 0.4);
    }
    const scrunchie = add(new THREE.TorusGeometry(3.2, 1.4, 12, 32), plain("#ff8fc7", 0.9), [12, DESK_Y + 1.2, -20], true);
    scrunchie.rotation.x = Math.PI / 2;

    // The desk lamp, seen far back on the left: a dark shade over a glowing bulb, its arm going down to the desk.
    const shade = add(new THREE.CylinderGeometry(5, 13, 14, 32, 1, true), plain("#1e2a3a", 0.5), LAMP_SEEN);
    shade.rotation.z = -0.5;
    shade.material = (() => {
      const m = new THREE.MeshStandardNodeMaterial({ color: "#1e2a3a", roughness: 0.5, side: THREE.DoubleSide });
      materials.push(m);
      return m;
    })();
    add(new THREE.SphereGeometry(3.6, 20, 14), plain("#fff2d8", 1, "#ffcf8a", 14), [LAMP_SEEN[0] + 3, LAMP_SEEN[1] - 4, LAMP_SEEN[2]]);
    const arm = add(new THREE.CylinderGeometry(0.9, 0.9, 50, 8), plain("#1e2a3a", 0.4), [LAMP_SEEN[0] - 8, (LAMP_SEEN[1] + DESK_Y) / 2 - 8, LAMP_SEEN[2] - 4]);
    arm.rotation.z = 0.25;
    glows.push([LAMP_SEEN[0] + 3, LAMP_SEEN[1] - 4, LAMP_SEEN[2] + 4, 1, 0.78, 0.5, 2.2, 1.6]);

    // The lava lamp: a dark cone base and cap, a glass taper of hot wax whose blobs rise and sink.
    add(new THREE.CylinderGeometry(4.5, 7, 12, 32), plain("#2a2d33", 0.35), [LAVA[0], LAVA[1] + 6, LAVA[2]]);
    const glass = new THREE.MeshStandardNodeMaterial({ roughness: 0.2 });
    {
      const p = positionLocal as any;
      const t = time as any;
      const blobs = mx_noise_float(vec3(p.x.mul(0.25), p.y.mul(0.14).sub(t.mul(0.08)), p.z.mul(0.25))).add(mx_noise_float(vec3(p.x.mul(0.2), p.y.mul(0.1).add(t.mul(0.05)), 3)).mul(0.6)) as any;
      const wax = smoothstep(0.1, 0.35, blobs) as any;
      const heat = float(1).sub(smoothstep(-2, 18, p.y)) as any;
      glass.colorNode = color("#200510") as any;
      glass.emissiveNode = mix(color("#ff2a6a").mul(0.5), color("#ff8a2a").mul(3.2), wax).mul(heat.mul(0.5).add(0.6)) as any;
    }
    materials.push(glass);
    add(new THREE.LatheGeometry([new THREE.Vector2(4.4, 0), new THREE.Vector2(6.2, 12), new THREE.Vector2(3.4, 30), new THREE.Vector2(0.01, 30.2)], 40), glass, [LAVA[0], LAVA[1] + 12, LAVA[2]]);
    add(new THREE.CylinderGeometry(2.2, 3.5, 6, 32), plain("#2a2d33", 0.35), [LAVA[0], LAVA[1] + 45, LAVA[2]]);
    for (const [dy, r, g, b, s, size] of [
      [18, 1, 0.42, 0.16, 1.6, 1.4],
      [28, 1, 0.2, 0.42, 1.1, 1.1],
      [36, 1, 0.3, 0.3, 0.8, 0.9]
    ])
      glows.push([LAVA[0], LAVA[1] + dy, LAVA[2] + 7, r, g, b, s, size]);

    // Posters, a little askew.
    const posters: [number, number, number, string, string[]][] = [
      [-48, 38, 0.04, "#1b2a6b", ["#ff4f9a", "#f7d046", "#4fe0c0", "#ffffff"]],
      [22, 52, -0.03, "#f7d046", ["#1b1b1f", "#ff4f9a", "#2f6bff"]],
      [88, 18, 0.06, "#0f0f14", ["#7a5cff", "#4fe0c0", "#ff8a2a"]]
    ];
    posters.forEach(([x, y, turn, ground, inks], k) => {
      const tex = poster(31 + k * 17, ground, inks);
      textures.push(tex);
      const m = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.7, color: "#8a8a8a" });
      materials.push(m);
      const mesh = add(new THREE.PlaneGeometry(48, 64), m, [x, y, WALL_Z + 0.5]);
      mesh.rotation.z = turn;
    });

    // Glow-in-the-dark stars scattered high on the wall: pale green, each a little five-pointed sticker.
    const star = new THREE.Shape();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + Math.PI / 2;
      const r = k % 2 ? 0.42 : 1;
      if (k === 0) star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const starGeometry = new THREE.ShapeGeometry(star);
    geometries.push(starGeometry);
    const starMaterial = plain("#cfe8c0", 0.9, "#b8ffb0", 1.6);
    const stars = new THREE.InstancedMesh(starGeometry, starMaterial, 46);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let k = 0; k < 46; k++) {
      const x = -160 + random() * 320;
      const y = -12 + random() * 85;
      const size = 1.6 + random() * 2.2;
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), random() * Math.PI);
      m4.compose(new THREE.Vector3(x, y, WALL_Z + 0.6), q, new THREE.Vector3(size, size, 1));
      stars.setMatrixAt(k, m4);
      glows.push([x, y, WALL_Z + 6, 0.62, 1, 0.6, 0.18 + random() * 0.3, 0.5 + size * 0.12]);
    }
    group.add(stars);

    // Fairy lights strung across the wall in two loose swags, warm.
    const bulb = new THREE.SphereGeometry(0.9, 10, 8);
    geometries.push(bulb);
    const fairy = new THREE.InstancedMesh(bulb, plain("#fff1d0", 1, "#ffc070", 10), 34);
    for (let k = 0; k < 34; k++) {
      const s = k / 33;
      const x = -170 + s * 340;
      const y = 58 - Math.sin(((s * 2) % 1) * Math.PI) * 20;
      m4.makeTranslation(x, y, WALL_Z + 3);
      fairy.setMatrixAt(k, m4);
      glows.push([x, y, WALL_Z + 8, 1, 0.75, 0.45, 0.6 + random() * 0.5, 1]);
    }
    group.add(fairy);

    // Light. The lamp: a warm spot on the toy from the left, soft-shadowed; its spill washing the wall and desk; a cool
    // dim rim from the window behind on the right; little else, so the right falls off into shadow.
    group.add(new THREE.HemisphereLight("#3c3552", "#1a120c", 0.18));
    const key = new THREE.SpotLight(WARM, 5.5, 0, 0.42, 0.9, 0);
    key.position.set(...LAMP);
    key.target.position.set(0, -1, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 10;
    key.shadow.camera.far = 140;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 5;
    group.add(key, key.target);
    const spill = new THREE.SpotLight(WARM, 1.3, 0, 0.8, 1, 0);
    spill.position.set(LAMP_SEEN[0] + 3, LAMP_SEEN[1] - 4, LAMP_SEEN[2] + 6);
    spill.target.position.set(-10, -5, WALL_Z);
    group.add(spill, spill.target);
    const rim = new THREE.DirectionalLight("#8ea4ff", 0.9);
    rim.position.set(40, 30, -60);
    group.add(rim);
    const lava = new THREE.PointLight("#ff3f7a", 1.4, 0, 0);
    lava.position.set(LAVA[0], LAVA[1] + 25, LAVA[2] + 10);
    group.add(lava);
    return { group, geometries, materials, textures, glows };
  }, []);
  useDispose(...parts.geometries, ...parts.materials, ...parts.textures);
  return (
    <>
      <primitive object={parts.group} />
      <Air glows={parts.glows} />
    </>
  );
}

// The beam from the lamp to the toy, seen in the dust; the dust itself; and bokeh discs where the room's lights are, all
// sized by how far out of focus they are. Drawn in the overlay pass, hidden behind whatever is nearer.
const BEAM_FROM = new THREE.Vector3(...LAMP);
const BEAM_DIR = new THREE.Vector3(0, -1, 0).sub(BEAM_FROM).normalize();
// The lens: how wide its aperture is (cm), for the size of a disc out of focus, and the most a disc may grow to (radians).
const APERTURE = 0.5;
const MOST = 0.035;

function Air({ glows }: { glows: Glow[] }) {
  const parts = useMemo(() => {
    const random = lehmer(7781);
    const geometries: THREE.BufferGeometry[] = [];
    const draw = () => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
      m.colorNode = vec4(0, 0, 0, 0);
      return m;
    };
    // The beam: a long box down the lamp's axis, wide enough to hold its soft edge.
    const beamMaterial = draw();
    beamMaterial.side = THREE.BackSide;
    const length = 80;
    const beamGeometry = new THREE.BoxGeometry(26, 26, length).translate(0, 0, length / 2 - 4);
    beamGeometry.lookAt(BEAM_DIR);
    beamGeometry.translate(BEAM_FROM.x, BEAM_FROM.y, BEAM_FROM.z);
    geometries.push(beamGeometry);
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    beam.layers.set(OVERLAY_LAYER);
    beam.frustumCulled = false;

    // Dust, and the discs: instanced quads that face the eye.
    const quad = (count: number, fill: (i: number) => number[]) => {
      const g = new THREE.PlaneGeometry(1, 1);
      const a = new Float32Array(count * 4);
      const b = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const v = fill(i);
        a.set(v.slice(0, 4), i * 4);
        b.set(v.slice(4, 8), i * 4);
      }
      g.setAttribute("aA", new THREE.InstancedBufferAttribute(a, 4));
      g.setAttribute("aB", new THREE.InstancedBufferAttribute(b, 4));
      geometries.push(g);
      const material = draw();
      const mesh = new THREE.InstancedMesh(g, material, count);
      const identity = new THREE.Matrix4();
      for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
      mesh.frustumCulled = false;
      mesh.layers.set(OVERLAY_LAYER);
      return { mesh, material };
    };
    const dust = quad(1400, () => [random(), random(), random(), random(), 0, 0, 0, 0]);
    // Each disc: where, then colour and strength and how big a bulb it is. A few strays too, warm, round the room.
    const all = [...glows];
    for (let k = 0; k < 22; k++) all.push([-200 + random() * 400, -10 + random() * 140, WALL_Z + 10 + random() * 60, 1, 0.7 + random() * 0.2, 0.45, 0.12 + random() * 0.2, 1]);
    const discs = quad(all.length, (i) => {
      const [x, y, z, r, g, b, s, size] = all[i];
      return [x, y, z, size, r * s, g * s, b * s, random()];
    });
    return { beam, beamMaterial, dust, discs, geometries };
  }, [glows]);
  useDispose(...parts.geometries, parts.beamMaterial, parts.dust.material, parts.discs.material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const t = time as any;
        const from = uniform(BEAM_FROM) as any;
        const axis = uniform(BEAM_DIR) as any;
        // The beam: march a few steps along the eye's line inside the box (stopping at the scene) and sum the light's
        // soft cone there, stirred by slow noise.
        parts.beamMaterial.colorNode = Fn(() => {
          const dir = normalize(positionWorld.sub(cameraPosition)) as any;
          const stop = sceneZ.div(normalize(positionView).z) as any;
          let sum: any = float(0);
          const steps = 10;
          for (let k = 0; k < steps; k++) {
            const d = min(stop, float(10 + k * 4.2)) as any;
            const p = cameraPosition.add(dir.mul(d)) as any;
            const rel = p.sub(from) as any;
            const along = dot(rel, axis) as any;
            const off = rel.sub(axis.mul(along)).length() as any;
            const radius = along.mul(0.2).add(1.5) as any;
            const cone = exp(off.mul(off).div(radius.mul(radius)).negate().mul(1.6)).mul(smoothstep(2, 10, along)) as any;
            const stir = mx_noise_float(p.mul(0.08).add(vec3(t.mul(0.15), t.mul(-0.05), 0))).mul(0.35).add(0.8) as any;
            sum = sum.add(cone.mul(stir).mul(step(float(10 + k * 4.2), stop)));
          }
          return vec4(color(WARM).mul(sum.mul(0.0032)), 1);
        })() as any;
        parts.beamMaterial.needsUpdate = true;

        // Dust: in a wide box round the toy and toward the lamp, slowly turning and sinking, bright where it crosses the
        // beam; one in six close to the lens, drifting past as big soft blooms.
        {
          const s = attribute("aA", "vec4") as any;
          const box = vec3(70, 46, 46) as any;
          const lo = vec3(-45, -18, -30) as any;
          const drift = vec3(sin(t.mul(0.05).add(s.w.mul(40))).mul(2), t.mul(-0.25).mul(s.w.add(0.4)), sin(t.mul(0.04).add(s.x.mul(31))).mul(2)) as any;
          const near = step(s.w, 0.16) as any;
          const inRoom = lo.add(fract(s.xyz.add(drift.div(box))).mul(box)) as any;
          const lensBox = 9;
          const lens = cameraPosition.add(fract(s.xyz.add(drift.div(lensBox)).sub(cameraPosition.div(lensBox))).sub(0.5).mul(lensBox)) as any;
          const centre = mix(inRoom, lens, near) as any;
          const toEye = normalize(cameraPosition.sub(centre).add(vec3(0, 0, 1e-5))) as any;
          const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-4, 0, 0))) as any;
          const up = cross(toEye, right) as any;
          const away = max(cameraPosition.sub(centre).length(), 1e-3) as any;
          const sharp = max(float(0.012), away.mul(0.0011)).mul(s.y.mul(1.2).add(0.5)) as any;
          const blur = min(away.sub(focusDistance).abs().mul(APERTURE * 0.5).div(focusDistance), away.mul(MOST)) as any;
          const radius = sharp.add(blur) as any;
          parts.dust.material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
          const rel = centre.sub(from) as any;
          const along = dot(rel, axis) as any;
          const off = rel.sub(axis.mul(along)).length() as any;
          const r0 = along.mul(0.2).add(1.5) as any;
          const lit = exp(off.mul(off).div(r0.mul(r0)).negate().mul(1.4)).mul(smoothstep(2, 10, along)) as any;
          const spread = sharp.div(radius).pow(2).max(0.02) as any;
          const twinkle = sin(t.mul(s.y.mul(2).add(0.6)).add(s.z.mul(50))).mul(0.3).add(0.7) as any;
          const r = uv().sub(0.5).length() as any;
          const soft = smoothstep(0.02, 0.2, blur) as any;
          const shape = mix(float(1).sub(smoothstep(0.1, 0.5, r)), float(1).sub(smoothstep(0.38, 0.5, r)).mul(0.8), soft) as any;
          const shown = step(sceneZ, positionView.z) as any;
          const bright = mix(float(0.05), float(2.6), lit.min(1)).mul(twinkle).mul(spread).mul(shape).mul(shown) as any;
          parts.dust.material.colorNode = vec4(color(WARM).mul(bright.min(3)), 1) as any;
          parts.dust.material.needsUpdate = true;
        }

        // Discs: each a soft-edged circle at the light's place, as wide as the lens would blur it, a touch brighter at
        // the rim like real bokeh, breathing slowly.
        {
          const a = attribute("aA", "vec4") as any;
          const b = attribute("aB", "vec4") as any;
          const centre = a.xyz as any;
          const toEye = normalize(cameraPosition.sub(centre)) as any;
          const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
          const up = cross(toEye, right) as any;
          const away = cameraPosition.sub(centre).length() as any;
          const blur = min(away.sub(focusDistance).abs().mul(APERTURE * 0.5).div(focusDistance), away.mul(MOST)) as any;
          const radius = blur.mul(a.w.mul(0.35).add(0.65)).add(a.w.mul(0.6)) as any;
          parts.discs.material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
          const r = uv().sub(0.5).length().mul(2) as any;
          const disc = float(1).sub(smoothstep(0.82, 1, r)).mul(smoothstep(0.5, 0.95, r).mul(0.25).add(0.75)) as any;
          // Spread over a larger disc, the same light is dimmer per pixel.
          const dim = float(1.2).div(radius.mul(radius).add(1)) as any;
          const breathe = sin(t.mul(0.4).add(b.w.mul(30))).mul(0.12).add(0.88) as any;
          const shown = step(sceneZ, positionView.z) as any;
          parts.discs.material.colorNode = vec4(b.xyz.mul(disc).mul(dim).mul(breathe).mul(shown).mul(0.55), 1) as any;
          parts.discs.material.needsUpdate = true;
        }
      }),
    [parts]
  );

  return (
    <>
      <primitive object={parts.beam} />
      <primitive object={parts.dust.mesh} />
      <primitive object={parts.discs.mesh} />
    </>
  );
}

