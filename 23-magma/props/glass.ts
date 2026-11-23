// A tumbler of cold milk: a lathe for the glass (a thick base, walls 2 mm, a rounded lip, a slight flare) and one for the
// milk inside (filled most of the way, a meniscus climbing the wall). y = 0 on the counter.

import * as THREE from "three/webgpu";

// About 6.5 cm across at the foot, 7 at the lip, 12.5 cm tall.
export const GLASS = { foot: 0.122, lip: 0.138, height: 0.5, wall: 0.008, base: 0.042, milk: 0.34 };

export const outerRadius = (y: number) => GLASS.foot + (GLASS.lip - GLASS.foot) * (y / GLASS.height);
export const innerRadius = (y: number) => outerRadius(y) - GLASS.wall;

export function glassGeometry(fine: boolean) {
  const { height, wall, base } = GLASS;
  const p: THREE.Vector2[] = [];
  // Listed from the underside's middle out, up the outside, over the lip, down the inside to the floor's middle: a lathe
  // faces the right of its profile's direction, which with this order is outward.
  p.push(new THREE.Vector2(0.0001, 0.004));
  // The foot: a slightly domed underside with a rounded heel.
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * (Math.PI / 2);
    p.push(new THREE.Vector2(GLASS.foot - 0.012 + Math.sin(a) * 0.012, 0.012 - Math.cos(a) * 0.012));
  }
  for (let k = 1; k <= 12; k++) {
    const y = 0.012 + (k / 12) * (height - 0.012 - wall / 2);
    p.push(new THREE.Vector2(outerRadius(y), y));
  }
  // The lip, a half round.
  for (let k = 1; k < 8; k++) {
    const a = (k / 8) * Math.PI;
    const c = outerRadius(height) - wall / 2;
    p.push(new THREE.Vector2(c + (Math.cos(a) * wall) / 2, height - wall / 2 + (Math.sin(a) * wall) / 2));
  }
  for (let k = 0; k <= 12; k++) {
    const y = height - wall / 2 - (k / 12) * (height - wall / 2 - base - 0.01);
    p.push(new THREE.Vector2(innerRadius(y), y));
  }
  // The inside floor, rounded into the wall.
  for (let k = 1; k <= 5; k++) {
    const a = (k / 5) * (Math.PI / 2);
    p.push(new THREE.Vector2(innerRadius(base) - 0.01 + Math.cos(a) * 0.01, base + 0.01 - Math.sin(a) * 0.01));
  }
  p.push(new THREE.Vector2(0.0001, base));
  return new THREE.LatheGeometry(p, fine ? 96 : 40);
}

// The milk: its outside just inside the glass's inner wall, its top a meniscus climbing about 2 mm at the wall.
export function milkGeometry(fine: boolean) {
  const { base, milk } = GLASS;
  const p: THREE.Vector2[] = [];
  const gap = 0.0006;
  p.push(new THREE.Vector2(0.0001, base + gap));
  for (let k = 1; k <= 4; k++) {
    const a = (k / 4) * (Math.PI / 2);
    p.push(new THREE.Vector2(innerRadius(base) - 0.01 - gap + Math.sin(a) * 0.01, base + 0.01 - Math.cos(a) * 0.01 + gap));
  }
  for (let k = 1; k <= 6; k++) {
    const y = base + 0.01 + (k / 6) * (milk + 0.008 - base - 0.01);
    p.push(new THREE.Vector2(innerRadius(y) - gap, y));
  }
  // The meniscus: up the wall, then over and in to the flat top.
  const r = innerRadius(milk) - gap;
  for (let k = 1; k <= 6; k++) {
    const t = k / 6;
    p.push(new THREE.Vector2(r - Math.pow(t, 2) * 0.02, milk + 0.008 * Math.pow(1 - t, 3)));
  }
  p.push(new THREE.Vector2(0.0001, milk));
  return new THREE.LatheGeometry(p, fine ? 96 : 40);
}
