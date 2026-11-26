"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  sin,
  smoothstep,
  texture,
  texture3D,
  transformNormalToView,
  vec2,
  vec3
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { loadRetried, suspendRetried } from "../../shared/engine/retry";
import { veil } from "./fog";
import { bakeGround, GROUND, groundHeight, TOWER } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Everything solid: the headland and the beach, the sea, the night sky with its moon, the lighthouse and the keeper's
// cottage, and a bell buoy out in the cove.

const ROCK = ["/assets/25-veil/low_tide_rocks_diff_2k.jpg", "/assets/25-veil/coast_sand_rocks_02_diff_2k.jpg"];

// The sea's swell: a few long, low waves from offshore, as (direction x, z, wavelength, height).
const WAVES: [number, number, number, number][] = [
  [0.2, 1, 38, 0.32],
  [-0.35, 1, 21, 0.18],
  [0.6, 0.8, 11, 0.08]
];

export function Coast({ noise }: { noise: THREE.Data3DTexture }) {
  const [rockColour, shingleColour] = suspendRetried(() => Promise.all(ROCK.map((url) => loadRetried(new THREE.TextureLoader(), url))), ["veil-rock", ...ROCK]);

  const ground = useMemo(() => {
    for (const t of [rockColour, shingleColour]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
    }
    const n = GROUND.cells;
    const geometry = new THREE.PlaneGeometry(GROUND.size, GROUND.size, n, n);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(GROUND.x + GROUND.size / 2, 0, GROUND.z + GROUND.size / 2);
    // The plane's vertices run row by row from the far edge, as the baked heights do.
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const baked = groundTexture().image.data as Float32Array;
    for (let i = 0; i < position.count; i++) position.setY(i, baked[i]);
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    const p = positionWorld as any;
    // Rock on the cliffs, read from two sides and from above; shingle on the beach; rough grass and heather on the
    // headland's top; all darker and glossier where the sea wets them.
    const side = (scale: number) =>
      (texture(rockColour, p.zy.mul(scale)) as any)
        .mul(0.5)
        .add((texture(rockColour, p.xy.mul(scale)) as any).mul(0.5)) as any;
    const top = texture(rockColour, p.xz.mul(0.18)) as any;
    const rock = mix(side(0.18).rgb, top.rgb, 0.4).mul(0.55) as any;
    const shingle = (texture(shingleColour, p.xz.mul(0.35)) as any).rgb.mul(0.6) as any;
    const patch = texture3D(noise, vec3(p.x.mul(0.02), 0.5, p.z.mul(0.02)), 0).g;
    const grass = mix(vec3(0.05, 0.07, 0.035), vec3(0.11, 0.1, 0.06), patch) as any;
    // Where each goes: the beach is low and gentle; the headland's top is high; cliffs and boulders between.
    const high = smoothstep(TOWER.ground - 5, TOWER.ground - 1.5, p.y) as any;
    const beach = float(1).sub(smoothstep(2.5, 4.5, p.y)).mul(smoothstep(0, 10, p.z)) as any;
    let colour: any = mix(rock, grass, high.mul(patch.mul(0.5).add(0.6)).min(1));
    colour = mix(colour, shingle, beach);
    const wet = float(1).sub(smoothstep(0.2, 1.4, p.y)) as any;
    material.colorNode = colour.mul(float(1).sub(wet.mul(0.45)));
    material.roughnessNode = mix(float(0.92), float(0.35), wet);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return { geometry, material, mesh };
  }, [rockColour, shingleColour, noise]);
  useDispose(ground.geometry, ground.material);

  const sea = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1400, 1400, 280, 280);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, 0, -500);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.1, metalness: 0 });
    const t = veil.time;
    // The swell's height and slope at a point.
    const swell = (x: any, z: any) => {
      let h: any = float(0);
      let dx: any = float(0);
      let dz: any = float(0);
      for (const [ax, az, length, height] of WAVES) {
        const len = Math.hypot(ax, az);
        const kx = ((ax / len) * 2 * Math.PI) / length;
        const kz = ((az / len) * 2 * Math.PI) / length;
        const omega = Math.sqrt((9.8 * 2 * Math.PI) / length);
        const phase = x.mul(kx).add(z.mul(kz)).add(t.mul(omega));
        h = h.add(sin(phase).mul(height));
        dx = dx.add(cos(phase).mul(height * kx));
        dz = dz.add(cos(phase).mul(height * kz));
      }
      return { h, dx, dz };
    };
    const g = positionGeometry as any;
    // The swell dies away into the shallows, where the ground rises under it.
    const atBuilt = swell(g.x, g.z);
    material.positionNode = vec3(g.x, atBuilt.h, g.z);
    const p = positionWorld as any;
    const at = swell(p.x, p.z);
    // Fine ripples on the swell, two taps of the drifting noise.
    const rip = (o: any) => texture3D(noise, vec3(p.x.mul(0.09).add(o), p.z.mul(0.09), t.mul(0.02)), 0).g;
    const r0 = rip(0);
    const rx = rip(0.01).sub(r0).mul(0.9);
    const rz = texture3D(noise, vec3(p.x.mul(0.09), p.z.mul(0.09).add(0.01), t.mul(0.02)), 0).g.sub(r0).mul(0.9);
    const world = normalize(vec3(at.dx.add(rx).negate(), 1, at.dz.add(rz).negate()));
    material.normalNode = transformNormalToView(world);
    // How deep the water is here (the ground under it), for foam where it breaks on the rocks and the beach.
    const uv = p.xz.sub(vec2(GROUND.x, GROUND.z)).div(GROUND.size) as any;
    const floorHeight = texture(groundTexture(), uv).r as any;
    const shallow = float(1).sub(smoothstep(-1.4, 0.15, floorHeight.negate())) as any;
    const churn = texture3D(noise, vec3(p.x.mul(0.18), p.z.mul(0.18).add(t.mul(0.05)), t.mul(0.08)), 0).r;
    const surge = sin(t.mul(0.9).add(p.x.mul(0.05)).add(p.z.mul(0.07))).mul(0.5).add(0.5);
    const foam = smoothstep(0.35, 0.8, shallow.mul(churn.mul(0.7).add(surge.mul(0.5)))).mul(0.6) as any;
    material.colorNode = mix(vec3(0.004, 0.009, 0.014), vec3(0.32, 0.34, 0.36), foam);
    material.roughnessNode = mix(float(0.07), float(0.8), foam);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return { geometry, material, mesh };
  }, [noise]);
  useDispose(sea.geometry, sea.material);

  const sky = useMemo(() => {
    const geometry = new THREE.SphereGeometry(1600, 48, 24);
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    const d = normalize(positionGeometry) as any;
    const up = d.y.max(0) as any;
    const base = mix(vec3(0.012, 0.018, 0.03), vec3(0.002, 0.004, 0.01), pow(up, 0.5)) as any;
    // Stars: one in a few cells of the sky, each its own brightness, faint near the horizon where the air is thick.
    const cell = floor(vec3(d.x, d.y, d.z).mul(220)) as any;
    const hash = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;
    const star = smoothstep(0.996, 1, hash).mul(smoothstep(0.05, 0.3, up)).mul(1.4) as any;
    // The moon, high over the open sea, in a wide halo.
    const toMoon = dot(d, veil.moon) as any;
    const disc = smoothstep(0.99985, 0.9999, toMoon) as any;
    const halo = exp(float(1).sub(toMoon).mul(-90)).mul(0.25).add(exp(float(1).sub(toMoon).mul(-12)).mul(0.04)) as any;
    material.colorNode = base.add(vec3(star)).add(vec3(0.8, 0.85, 0.95).mul(disc.mul(3).add(halo)));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = -1;
    mesh.frustumCulled = false;
    return { geometry, material, mesh };
  }, []);
  useDispose(sky.geometry, sky.material);

  return (
    <>
      <primitive object={ground.mesh} />
      <primitive object={sea.mesh} />
      <primitive object={sky.mesh} />
      <Lighthouse />
      <Buoy />
    </>
  );
}

// The ground's heights as a texture, made once.
let heights: THREE.DataTexture | null = null;
function groundTexture() {
  heights ??= bakeGround().texture;
  return heights;
}

// The lighthouse: a tapering white tower with a black-painted gallery and lantern on top, the lamp inside its glass,
// and the keeper's cottage at its foot with its windows lit.
function Lighthouse() {
  const parts = useMemo(() => {
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const keep = <T extends THREE.Material>(m: T) => (materials.push(m), m);
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) => {
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };

    const H = TOWER.height;
    // The tower: limewashed, a little grimy toward its foot, with a broad red band under the gallery.
    const profile: THREE.Vector2[] = [];
    profile.push(new THREE.Vector2(0, -1.5));
    profile.push(new THREE.Vector2(TOWER.base + 0.3, -1.5));
    profile.push(new THREE.Vector2(TOWER.base + 0.3, 0.4));
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      profile.push(new THREE.Vector2(TOWER.base + (TOWER.top - TOWER.base) * Math.pow(t, 0.9), 0.4 + (H - 0.4) * t));
    }
    profile.push(new THREE.Vector2(0, H));
    const plaster = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.85 }));
    const y = positionGeometry.y as any;
    const grime = float(1).sub(smoothstep(0, 6, y)).mul(0.35) as any;
    const band = smoothstep(H - 5.2, H - 5.0, y).mul(float(1).sub(smoothstep(H - 1.4, H - 1.2, y))) as any;
    plaster.colorNode = mix(mix(vec3(0.82, 0.8, 0.76), vec3(0.42, 0.4, 0.36), grime), vec3(0.5, 0.06, 0.05), band) as any;
    add(new THREE.LatheGeometry(profile, 48), plaster);

    // The gallery: a deck round the top, a rail on posts.
    const iron = keep(new THREE.MeshStandardNodeMaterial({ color: "#151719", roughness: 0.55, metalness: 0.4 }));
    add(new THREE.CylinderGeometry(TOWER.top + 1.1, TOWER.top + 0.6, 0.35, 48), iron, 0, H + 0.1, 0);
    const posts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 28; k++) {
      const a = (k / 28) * Math.PI * 2;
      const post = new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6);
      post.translate(Math.cos(a) * (TOWER.top + 1.0), H + 0.8, Math.sin(a) * (TOWER.top + 1.0));
      posts.push(post);
    }
    const rail = new THREE.TorusGeometry(TOWER.top + 1.0, 0.04, 6, 64);
    rail.rotateX(Math.PI / 2);
    rail.translate(0, H + 1.35, 0);
    posts.push(rail);
    for (const g of posts) add(g, iron);

    // The lantern: a ring of glazing bars round the lamp, a low wall under it, a domed roof and its vent.
    const R = 1.55;
    add(new THREE.CylinderGeometry(R + 0.1, R + 0.1, 1.2, 32), iron, 0, H + 0.85, 0);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const bar = new THREE.BoxGeometry(0.07, 2.6, 0.07);
      bar.translate(Math.cos(a) * R, H + 2.75, Math.sin(a) * R);
      add(bar, iron);
    }
    const roof = new THREE.SphereGeometry(R + 0.25, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    roof.scale(1, 0.65, 1);
    add(roof, iron, 0, H + 4.05, 0);
    add(new THREE.SphereGeometry(0.28, 16, 10), iron, 0, H + 5.25, 0);

    // The glass: lit from within by the lamp, warm; and the lamp, too bright to look at, brighter still as a beam faces.
    const glass = keep(new THREE.MeshStandardNodeMaterial({ roughness: 0.08, metalness: 0, transparent: true, opacity: 0.35 }));
    glass.colorNode = vec3(0.6, 0.55, 0.45);
    glass.emissiveNode = vec3(1.0, 0.78, 0.5).mul(0.6);
    const pane = new THREE.CylinderGeometry(R, R, 2.6, 32, 1, true);
    add(pane, glass, 0, H + 2.75, 0).castShadow = false;
    const lamp = keep(new THREE.MeshBasicNodeMaterial());
    lamp.colorNode = vec3(1.0, 0.9, 0.72).mul(veil.flare.mul(30).add(6));
    add(new THREE.SphereGeometry(0.45, 24, 16), lamp, 0, H + 2.3, 0).castShadow = false;

    // The keeper's cottage: whitewashed, a slate roof, two windows lit.
    const cottage = new THREE.Group();
    const wall = keep(new THREE.MeshStandardNodeMaterial({ color: "#b9b4aa", roughness: 0.9 }));
    const slate = keep(new THREE.MeshStandardNodeMaterial({ color: "#1d2024", roughness: 0.7 }));
    const window_ = keep(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1.6, 0.95, 0.45) }));
    const body = new THREE.BoxGeometry(9, 3.6, 5.5);
    body.translate(0, 1.6, 0);
    geometries.push(body);
    cottage.add(new THREE.Mesh(body, wall));
    const roofShape = new THREE.Shape([new THREE.Vector2(-3.2, 0), new THREE.Vector2(3.2, 0), new THREE.Vector2(0, 2.3)]);
    const roofGeometry = new THREE.ExtrudeGeometry(roofShape, { depth: 9.6, bevelEnabled: false });
    roofGeometry.rotateY(Math.PI / 2);
    roofGeometry.translate(-4.8, 3.4, 0);
    geometries.push(roofGeometry);
    cottage.add(new THREE.Mesh(roofGeometry, slate));
    for (const wx of [-2.4, 1.8]) {
      const pane = new THREE.PlaneGeometry(0.9, 1.1);
      pane.translate(wx, 1.9, 2.76);
      geometries.push(pane);
      cottage.add(new THREE.Mesh(pane, window_));
    }
    const chimney = new THREE.BoxGeometry(0.7, 2.2, 0.7);
    chimney.translate(3.2, 5, 0);
    geometries.push(chimney);
    cottage.add(new THREE.Mesh(chimney, wall));
    cottage.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    const cx = TOWER.x + 11;
    const cz = TOWER.z + 9;
    cottage.position.set(cx, groundHeight(cx, cz) - 0.3, cz);
    cottage.rotation.y = 0.5;
    group.add(cottage);

    group.position.set(TOWER.x, TOWER.ground, TOWER.z);
    cottage.position.sub(group.position);
    return { group, geometries, materials };
  }, []);
  useDispose(...parts.geometries, ...parts.materials);
  return <primitive object={parts.group} />;
}

// A bell buoy rocking in the cove, its red light blinking every few seconds.
function Buoy() {
  const parts = useMemo(() => {
    const group = new THREE.Group();
    const red = new THREE.MeshStandardNodeMaterial({ color: "#6a1410", roughness: 0.6 });
    const frame = new THREE.MeshStandardNodeMaterial({ color: "#1a1a1a", roughness: 0.5, metalness: 0.5 });
    const light = new THREE.MeshBasicNodeMaterial();
    const blink = fract(veil.time.mul(0.25)) as any;
    light.colorNode = vec3(4, 0.25, 0.1).mul(float(1).sub(smoothstep(0.0, 0.08, blink)).mul(clamp(blink.mul(60), 0, 1)).add(0.02));
    const hull = new THREE.CylinderGeometry(0.9, 1.1, 1.0, 20);
    const cage = new THREE.CylinderGeometry(0.35, 0.7, 2.2, 4, 1, true);
    cage.translate(0, 1.6, 0);
    const lamp = new THREE.SphereGeometry(0.16, 12, 8);
    lamp.translate(0, 2.85, 0);
    group.add(new THREE.Mesh(hull, red), new THREE.Mesh(cage, frame), new THREE.Mesh(lamp, light));
    group.position.set(14, 0, -22);
    return { group, geometries: [hull, cage, lamp], materials: [red, frame, light] };
  }, []);
  useDispose(...parts.geometries, ...parts.materials);
  useFrame(() => {
    const t = veil.time.value;
    parts.group.position.y = Math.sin(t * 0.9) * 0.25 - 0.2;
    parts.group.rotation.z = Math.sin(t * 0.8 + 1) * 0.12;
    parts.group.rotation.x = Math.sin(t * 0.6) * 0.08;
  });
  return <primitive object={parts.group} />;
}
