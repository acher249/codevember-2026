"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { atan, color, float, mix, mx_noise_float, positionLocal, smoothstep, step, uniform, vec2, vec3 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { type Parcel, type Pendulum, VESSELS } from "./pendulum";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What hangs: a divided paint bucket, its two pools separated by a white wall, each feeding its own outlet.
// The bucket hangs along the rope's line and turns about it as it spins. Each stream is drawn through its parcels,
// as thick as the paint each carries spread over the gap to the next, thinning into beads as it stretches.

// A two-outlet mark, printed four times round the bucket so one always faces the eye.
function holeMark(around: any, y: any, radius: number, centre: number, R: number) {
  const folded = around.add(Math.PI).mod(Math.PI / 2).sub(Math.PI / 4) as any;
  const p = vec2(folded.mul(radius), y.sub(centre)) as any;
  const aa = R * 0.06;
  const ring = float(1).sub(smoothstep(R * 0.08, R * 0.08 + aa, p.length().sub(R).abs())) as any;
  const dot = (side: number) => float(1).sub(smoothstep(R * 0.2, R * 0.2 + aa, p.sub(vec2(side * R * 0.55, 0)).length())) as any;
  return ring.max(dot(-1)).max(dot(1)) as any;
}

const SEGMENTS = 1400;
const BEADS = 600;

export function Rig({ pendulum, paintColour, secondColour }: { pendulum: Pendulum; paintColour: string; secondColour?: string }) {
  const tint = useMemo(() => uniform(new THREE.Color()), []);
  tint.value.set(paintColour);
  const tintB = useMemo(() => uniform(new THREE.Color()), []);
  tintB.value.set(secondColour ?? paintColour);
  const parts = useMemo(() => {
    // The divider and the two logical outlets share the local x axis: positive is A, negative is B.
    const paintTint = mix(tint, tintB, step(0, positionLocal.x.negate())) as any;
    // The beam, rough-sawn, across the room over the canvas, and the eye bolt under it.
    const wood = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    const grain = mx_noise_float(positionLocal.mul(vec3(1.5, 30, 30))).mul(0.5).add(0.5) as any;
    wood.colorNode = mix(color("#3a2a1c"), color("#5a4430"), grain) as any;
    const beamGeometry = new THREE.BoxGeometry(7, 0.2, 0.14);
    const beam = new THREE.Mesh(beamGeometry, wood);
    beam.position.copy(pendulum.pivot).add(new THREE.Vector3(0, 0.12, 0));
    beam.castShadow = true;
    const steel = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 1 });
    steel.colorNode = color("#8a8a86") as any;
    const eyeGeometry = new THREE.TorusGeometry(0.018, 0.005, 8, 20);
    const eye = new THREE.Mesh(eyeGeometry, steel);
    eye.position.copy(pendulum.pivot).add(new THREE.Vector3(0, 0.015, 0));

    // The rope: braided cotton, a unit tall, stretched each frame from the eye to the bail.
    const rope = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
    const twist = positionLocal.y.mul(260).add(atan(positionLocal.x, positionLocal.z).mul(2)).sin().mul(0.5).add(0.5) as any;
    rope.colorNode = mix(color("#b9ab92"), color("#e2d8c2"), twist) as any;
    const ropeGeometry = new THREE.CylinderGeometry(0.0045, 0.0045, 1, 10, 1).translate(0, 0.5, 0);
    const ropeMesh = new THREE.Mesh(ropeGeometry, rope);
    ropeMesh.castShadow = true;

    // Paint-coated inner walls retain the two chamber colours as the pools drain.
    const inside = new THREE.MeshStandardNodeMaterial({ roughness: 0.25, side: THREE.BackSide });
    const streak = mx_noise_float(vec3(atan(positionLocal.x, positionLocal.z).mul(5), positionLocal.y.mul(18), 0)).mul(0.5).add(0.5) as any;
    inside.colorNode = mix(color("#2e2d2b"), paintTint, streak.mul(0.6).add(0.35)) as any;
    // The paint inside is glossy, with a separate colour for each half.
    const wetPaint = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 });
    wetPaint.colorNode = tint as any;

    // The knot where the rope is tied to the bail: a lumpy hitch with two wraps and a short loose tail. Built round the
    // rope's end, up its line.
    const knot = new THREE.Group();
    const lumpGeometry = new THREE.SphereGeometry(0.0105, 14, 10).scale(1.15, 1.5, 1.05).translate(0, 0.008, 0);
    const wrapGeometry = new THREE.TorusGeometry(0.009, 0.0042, 8, 18).rotateX(Math.PI / 2);
    const tailGeometry = new THREE.CylinderGeometry(0.0042, 0.0036, 0.04, 8).translate(0, -0.02, 0);
    const lump = new THREE.Mesh(lumpGeometry, rope);
    const wrapA = new THREE.Mesh(wrapGeometry, rope);
    wrapA.position.y = 0.012;
    wrapA.rotation.z = 0.25;
    const wrapB = new THREE.Mesh(wrapGeometry, rope);
    wrapB.position.y = 0.003;
    wrapB.rotation.z = -0.3;
    const tail = new THREE.Mesh(tailGeometry, rope);
    tail.position.set(0.008, 0.006, 0.004);
    tail.rotation.set(0.25, 0, 0.45);
    knot.add(lump, wrapA, wrapB, tail);
    knot.traverse((o) => ((o as THREE.Mesh).castShadow = true));

    // The bucket: a wide white plastic pail, tapering to its base, with a thick rolled lip, two ribs, paint run down its
    // side, two outlets beside the divider, a wire bail with a plastic grip, and paint inside at its level.
    const pail = VESSELS.divided;
    const bucket = new THREE.Group();
    const plastic = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.5, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.4 });
    const pY = positionLocal.y as any;
    const pAround = atan(positionLocal.x, positionLocal.z) as any;
    const pRuns = smoothstep(0.5, 0.85, pAround.mul(6).sin().mul(pAround.mul(2.7).add(1.3).sin())) as any;
    const pLength = mx_noise_float(vec3(pAround.mul(3), 4, 0)).mul(0.1).add(0.12) as any;
    const pFrom = float(pail.height).sub(pLength) as any;
    const pDrip = pRuns.mul(smoothstep(pFrom, pFrom.add(0.025), pY)) as any;
    const scuff = mx_noise_float(positionLocal.mul(40)).mul(0.04) as any;
    const pMark = holeMark(pAround, pY, pail.bottom + 0.01, 0.1, 0.038) as any;
    plastic.colorNode = mix(mix(color("#e6e3dc").sub(scuff), color("#1b1b1c"), pMark), paintTint, pDrip) as any;
    plastic.roughnessNode = mix(float(0.5), float(0.18), pDrip) as any;
    plastic.clearcoatNode = mix(float(0.3), float(0.9), pDrip) as any;
    const pailGeometry = new THREE.CylinderGeometry(pail.top, pail.bottom, pail.height, 56, 1, true).translate(0, pail.height / 2, 0);
    const pailBody = new THREE.Mesh(pailGeometry, plastic);
    const pailInnerGeometry = new THREE.CylinderGeometry(pail.top - 0.004, pail.bottom - 0.004, pail.height - 0.004, 56, 1, true).translate(0, pail.height / 2 + 0.002, 0);
    const pailInner = new THREE.Mesh(pailInnerGeometry, inside);
    // The shared interior material draws back faces, so the floor's normal points down to show its painted side above.
    const pailInnerFloorGeometry = new THREE.CircleGeometry(pail.bottom - 0.004, 48).rotateX(Math.PI / 2).translate(0, 0.004, 0);
    const pailInnerFloor = new THREE.Mesh(pailInnerFloorGeometry, inside);
    const pailBaseGeometry = new THREE.CircleGeometry(pail.bottom, 56).rotateX(Math.PI / 2);
    const pailBase = new THREE.Mesh(pailBaseGeometry, plastic);
    const lipGeometry = new THREE.TorusGeometry(pail.top + 0.002, 0.0065, 10, 56).rotateX(Math.PI / 2).translate(0, pail.height, 0);
    const lip = new THREE.Mesh(lipGeometry, plastic);
    const ribAt = (h: number) => pail.bottom + ((pail.top - pail.bottom) * h) / pail.height + 0.0015;
    const ribGeometryA = new THREE.TorusGeometry(ribAt(0.17), 0.003, 6, 56).rotateX(Math.PI / 2).translate(0, 0.17, 0);
    const ribGeometryB = new THREE.TorusGeometry(ribAt(0.2), 0.003, 6, 56).rotateX(Math.PI / 2).translate(0, 0.2, 0);
    const ribA = new THREE.Mesh(ribGeometryA, plastic);
    const ribB = new THREE.Mesh(ribGeometryB, plastic);
    // Holes, seen from below: dark discs just under the base where each one is.
    const dark = new THREE.MeshBasicNodeMaterial();
    dark.colorNode = color("#060606") as any;
    const holeGeometry = new THREE.CircleGeometry(0.0055, 14).rotateX(Math.PI / 2);
    const holes = new THREE.Group();
    for (let k = 0; k < pail.holes; k++) {
      const angle = (k / pail.holes) * Math.PI * 2;
      const hole = new THREE.Mesh(holeGeometry, dark);
      hole.position.set(Math.cos(angle) * pail.ring, -0.0015, Math.sin(angle) * pail.ring);
      holes.add(hole);
    }
    const pailBailGeometry = new THREE.TorusGeometry(pail.top, 0.0026, 6, 40, Math.PI).scale(1, pail.bail / pail.top, 1).translate(0, pail.height, 0);
    const pailBail = new THREE.Mesh(pailBailGeometry, steel);
    const gripMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
    gripMaterial.colorNode = color("#1b1b1d") as any;
    const gripGeometry = new THREE.CylinderGeometry(0.011, 0.011, 0.09, 14).rotateZ(Math.PI / 2).translate(0, pail.height + pail.bail - 0.002, 0);
    const grip = new THREE.Mesh(gripGeometry, gripMaterial);
    // Two separate pools meet a solid white wall, running down the bucket's centre to its floor.
    const wetPaintB = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 });
    wetPaintB.colorNode = tintB as any;
    const halfSurfaceGeometry = new THREE.CircleGeometry(1, 32, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2);
    const halfA = new THREE.Mesh(halfSurfaceGeometry, wetPaint);
    const halfB = new THREE.Mesh(halfSurfaceGeometry, wetPaintB);
    halfB.rotation.y = Math.PI;
    const dividedSurface = new THREE.Group();
    dividedSurface.add(halfA, halfB);
    const dividerShape = new THREE.Shape();
    dividerShape.moveTo(-pail.bottom + 0.004, 0.004);
    dividerShape.lineTo(pail.bottom - 0.004, 0.004);
    dividerShape.lineTo(pail.top - 0.004, pail.height + 0.002);
    dividerShape.lineTo(-pail.top + 0.004, pail.height + 0.002);
    dividerShape.closePath();
    const dividerGeometry = new THREE.ExtrudeGeometry(dividerShape, { depth: 0.008, bevelEnabled: false, curveSegments: 1 }).translate(0, 0, -0.004).rotateY(Math.PI / 2);
    const dividerMaterial = new THREE.MeshPhysicalNodeMaterial({ color: "#f2f0e9", roughness: 0.35, metalness: 0, clearcoat: 0.3 });
    const divider = new THREE.Mesh(dividerGeometry, dividerMaterial);
    divider.receiveShadow = true;
    bucket.add(pailBody, pailInner, pailInnerFloor, pailBase, lip, ribA, ribB, holes, pailBail, grip, dividedSurface, divider);
    bucket.traverse((o) => ((o as THREE.Mesh).castShadow = true));

    // The stream: a tube a segment between each two parcels, and beads where it breaks up.
    const streamMaterial = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02 });
    const segmentGeometry = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0);
    const segments = new THREE.InstancedMesh(segmentGeometry, streamMaterial, SEGMENTS);
    segments.frustumCulled = false;
    segments.castShadow = true;
    // One to start with, so their shaders are built with the rest while loading; the first frame sets the real count.
    segments.count = 1;
    // Allocate colour attributes before the first shader compile; every segment keeps its parcel's original paint.
    segments.setColorAt(0, new THREE.Color(pendulum.colour));
    const beadGeometry = new THREE.SphereGeometry(1, 12, 8);
    const beads = new THREE.InstancedMesh(beadGeometry, streamMaterial, BEADS);
    beads.frustumCulled = false;
    beads.castShadow = true;
    beads.count = 1;
    beads.setColorAt(0, new THREE.Color(pendulum.colour));
    return {
      beam,
      eye,
      ropeMesh,
      knot,
      bucket,
      dividedSurface,
      segments,
      beads,
      geometries: [pailInnerGeometry, pailInnerFloorGeometry, beamGeometry, eyeGeometry, ropeGeometry, segmentGeometry, beadGeometry, lumpGeometry, wrapGeometry, tailGeometry, pailGeometry, pailBaseGeometry, lipGeometry, ribGeometryA, ribGeometryB, holeGeometry, pailBailGeometry, gripGeometry, halfSurfaceGeometry, dividerGeometry],
      materials: [inside, wood, steel, rope, wetPaint, wetPaintB, streamMaterial, plastic, dark, gripMaterial, dividerMaterial]
    };
  }, [tint, tintB, pendulum]);
  useDispose(...parts.geometries, ...parts.materials);

  const scratch = useMemo(() => ({ up: new THREE.Vector3(), q: new THREE.Quaternion(), m: new THREE.Matrix4(), a: new THREE.Vector3(), b: new THREE.Vector3(), order: [] as Parcel[], s: new THREE.Vector3(), x: new THREE.Vector3(), z: new THREE.Vector3(), basis: new THREE.Matrix4(), colour: new THREE.Color() }), []);
  useFrame(() => {
    const { up, q, m, a, b, order, s, x, z, basis, colour } = scratch;
    // Keep the beam and eye aligned if the suspension point moves.
    parts.beam.position.copy(pendulum.pivot).addScaledVector(Y, 0.12);
    parts.eye.position.copy(pendulum.pivot).addScaledVector(Y, 0.015);
    // The rope from the eye to the bail; the bucket hanging along the rope's line below it.
    up.subVectors(pendulum.pivot, pendulum.end);
    const length = up.length();
    up.normalize();
    q.setFromUnitVectors(Y, up.clone().negate());
    parts.ropeMesh.quaternion.setFromUnitVectors(Y, up);
    parts.ropeMesh.position.copy(pendulum.end);
    parts.ropeMesh.scale.set(1, length, 1);
    // The knot at the rope's end, up its line.
    parts.knot.position.copy(pendulum.end);
    parts.knot.quaternion.setFromUnitVectors(Y, up);
    // The vessel: its bail at the rope's end, hanging down the rope's line, turned about it as it spins.
    const v = VESSELS.divided;
    pendulum.frame(x, a, z);
    parts.bucket.quaternion.setFromRotationMatrix(basis.makeBasis(x, a, z));
    parts.bucket.position.copy(pendulum.end).addScaledVector(up, -(v.height + v.bail));
    const depth = 0.006 + pendulum.level * v.height * 0.85;
    const across = v.bottom + ((v.top - v.bottom) * depth) / v.height - 0.004;
    parts.dividedSurface.position.y = depth;
    parts.dividedSurface.scale.set(across, 1, across);
    parts.dividedSurface.visible = pendulum.level > 0.01;

    // Each outlet's coloured filaments, oldest parcel (lowest) to newest (at the opening).
    order.length = 0;
    for (const p of pendulum.parcels) if (p.alive) order.push(p);
    order.sort((x, y) => x.stream - y.stream || x.born - y.born);
    let segs = 0;
    let beadCount = 0;
    for (let k = 0; k < order.length; k++) {
      const from = order[k];
      if (from.paint) colour.setRGB(from.paint.linear[0], from.paint.linear[1], from.paint.linear[2]);
      else colour.set(from.colour);
      const last = k + 1 >= order.length || order[k + 1].stream !== from.stream;
      // Parcels let go far apart in time are separate pours, not one stream.
      if (!last && (order[k + 1].layout !== from.layout || order[k + 1].born - from.born > 0.02)) continue;
      if (last && (!pendulum.streamMatches(from) || pendulum.held || pendulum.finished || pendulum.time - from.born > 0.02)) continue;
      const to = last ? pendulum.streamAt(from.stream, b) : order[k + 1].p;
      a.subVectors(to, from.p);
      const gap = a.length();
      if (gap < 1e-5) continue;
      // As thick as its paint spread over the gap: a stretched stream is thin.
      const radius = Math.sqrt(from.volume / (Math.PI * gap));
      if (radius < 0.0009) {
        // Too thin to hold together: it breaks into a bead holding the same paint.
        if (beadCount < BEADS) {
          const r = Math.cbrt((3 * from.volume) / (4 * Math.PI));
          m.makeScale(r, r * 1.15, r).setPosition(from.p);
          parts.beads.setColorAt(beadCount, colour);
          parts.beads.setMatrixAt(beadCount++, m);
        }
        continue;
      }
      if (segs >= SEGMENTS) continue;
      const r = Math.min(radius, 0.0045);
      s.copy(a).divideScalar(gap);
      q.setFromUnitVectors(Y, s);
      m.compose(from.p, q, a.set(r, gap * 1.08, r));
      parts.segments.setColorAt(segs, colour);
      parts.segments.setMatrixAt(segs++, m);
    }
    parts.segments.count = segs;
    parts.beads.count = beadCount;
    parts.segments.instanceMatrix.needsUpdate = true;
    parts.beads.instanceMatrix.needsUpdate = true;
    if (parts.segments.instanceColor) parts.segments.instanceColor.needsUpdate = true;
    if (parts.beads.instanceColor) parts.beads.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <primitive object={parts.beam} />
      <primitive object={parts.eye} />
      <primitive object={parts.ropeMesh} />
      <primitive object={parts.bucket} />
      <primitive object={parts.knot} />
      <primitive object={parts.segments} />
      <primitive object={parts.beads} />
    </>
  );
}

const Y = new THREE.Vector3(0, 1, 0);
