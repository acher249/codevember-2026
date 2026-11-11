"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useState } from "react";
import * as THREE from "three/webgpu";
import { GaussianSplat } from "three/addons/objects/GaussianSplat.js";
import { SPZLoader } from "three/addons/loaders/SPZLoader.js";

// Where the subject stands in the scan, in the scan's own units: the foot of its axis, how far around it to keep, and
// how far below and above. Scans come out upside down as often as not, so `flip` turns it the right way up.
export type Framing = {
  foot: [number, number, number];
  radius: number;
  below: number;
  above: number;
  flip: boolean;
  // How tall one scan unit should stand in the scene.
  scale: number;
};

// Keeps the splats within a cylinder around the subject, less any stray sky, fading the outer edge of the cut so the ground has no hard rim.
function crop(source: THREE.BufferGeometry, { foot, radius, below, above, flip }: Framing) {
  const position = source.getAttribute("position").array;
  const rgba = source.getAttribute("color").array;
  const covariance = source.getAttribute("covariance").array;
  const up = flip ? -1 : 1;
  const kept: number[] = [];
  const fade: number[] = [];
  for (let i = 0; i < position.length / 3; i++) {
    const dx = position[i * 3] - foot[0];
    const dz = position[i * 3 + 2] - foot[2];
    const height = (position[i * 3 + 1] - foot[1]) * up;
    const reach = Math.hypot(dx, dz);
    if (reach > radius || height < -below || height > above) continue;
    // Scraps of sky that the scan stuck onto the subject: bluer than they are red or green.
    const [r, g, b] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    if (b > r + 25 && b > g + 5) continue;
    // Floaters: blurry blobs the scan left hanging in the air. Rust is warm, so a large splat that is as blue as it is red
    // is sky, a large faint one is haze, and anything very large is a smear. Most splats here are a few thousandths across.
    const size = Math.sqrt(covariance[i * 6] + covariance[i * 6 + 3] + covariance[i * 6 + 5]);
    if (size > 0.022 || (size > 0.01 && b >= r - 4) || (size > 0.008 && rgba[i * 4 + 3] < 90)) continue;
    kept.push(i);
    fade.push(Math.min(1, (radius - reach) / (radius * 0.35)));
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes) as [string, THREE.BufferAttribute][]) {
    const size = attribute.itemSize;
    const values = new (attribute.array.constructor as new (length: number) => typeof attribute.array)(kept.length * size);
    kept.forEach((from, to) => {
      for (let k = 0; k < size; k++) values[to * size + k] = attribute.array[from * size + k];
    });
    out.setAttribute(name, new THREE.BufferAttribute(values, size, attribute.normalized));
  }
  // Opacity rides in the colour's fourth byte.
  const color = out.getAttribute("color").array as Uint8Array;
  fade.forEach((f, i) => (color[i * 4 + 3] *= f * f * (3 - 2 * f)));
  return out;
}

// A scanned subject, as Gaussian splats drawn by three.js's own WebGPU splat renderer, which sorts them on the GPU every
// frame. It is cropped, turned upright and stood with its foot at the origin.
export function Scan({ url, framing, core, onPress }: { url: string; framing: Framing; core?: { radius: number; height: number; offset: [number, number]; color: string }; onPress?: (event: ThreeEvent<PointerEvent>) => void }) {
  const [splats, setSplats] = useState<GaussianSplat | null>(null);

  useEffect(() => {
    let made: GaussianSplat | null = null;
    let live = true;
    new SPZLoader().loadAsync(url).then((geometry) => {
      const kept = crop(geometry, framing);
      geometry.dispose();
      if (!live) return kept.dispose();
      made = new GaussianSplat(kept);
      const { foot, scale, flip } = framing;
      made.scale.setScalar(scale);
      if (flip) made.rotation.x = Math.PI;
      made.position.set(-foot[0], flip ? foot[1] : -foot[1], flip ? foot[2] : -foot[2]).multiplyScalar(scale);
      setSplats(made);
    });
    return () => {
      live = false;
      made?.geometry.dispose();
      made?.splatGeometry.dispose();
      (made?.material as THREE.Material | undefined)?.dispose();
    };
  }, [url, framing]);

  if (!splats) return null;
  return (
    <>
      <primitive object={splats} onPointerDown={onPress} renderOrder={2} />
      {core ? (
        // A solid core inside the subject, just within its surface, in its colour. Splats thin out toward the middle of a
        // thin thing, enough to see what passes behind; this stops that.
        <mesh position={[core.offset[0], core.height / 2, core.offset[1]]}>
          <cylinderGeometry args={[core.radius, core.radius, core.height, 20]} />
          <meshBasicMaterial color={core.color} />
        </mesh>
      ) : null}
    </>
  );
}

// Where a scan made from one photograph sits: the photo's camera at `eye`, looking down -z, `scale` scene units to one of
// the scan's, `level` radians of upward tilt taken out so its ground lies flat, and `widen` to stretch it sideways so a
// wider screen than the photo's doesn't find its edges, and `lift` to stretch it upward so its sky reaches higher.
export type Place = { eye: [number, number, number]; scale: number; level: number; widen: number; lift: number };

// A whole scene made from a single photograph, used as the world around the subject. It keeps the photo's camera, so it
// only looks right from near where the photo was taken.
export function Backdrop({ url, place }: { url: string; place: Place }) {
  const [splats, setSplats] = useState<GaussianSplat | null>(null);

  useEffect(() => {
    let made: GaussianSplat | null = null;
    let live = true;
    new SPZLoader().loadAsync(url).then((geometry) => {
      if (!live) return geometry.dispose();
      made = new GaussianSplat(geometry);
      // The scan's camera looks down +z with y pointing down; turned over, it looks down -z with y up.
      made.rotation.x = Math.PI;
      setSplats(made);
    });
    return () => {
      live = false;
      made?.geometry.dispose();
      made?.splatGeometry.dispose();
      (made?.material as THREE.Material | undefined)?.dispose();
    };
  }, [url]);

  if (!splats) return null;
  return (
    <group position={place.eye} rotation-x={place.level} scale={[place.scale * place.widen, place.scale * place.lift, place.scale]}>
      <primitive object={splats} renderOrder={0} />
    </group>
  );
}
