"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { useDispose } from "../shared/engine/dispose";
import { Fn, attribute, color, cos, dot, length, max, normalize, positionGeometry, positionWorld, pow, uniform, varying, vec3, vec4 } from "three/tsl";
import { sky } from "./backdrop";
import type { Look } from "./versions";
import type { Web } from "./web";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Each length of silk is a strip turned to face the eye, never thinner than about a pixel, and fainter by however much
// it had to be widened, so far threads stay fine rather than vanishing or turning to wire. Silk is all in how it takes
// the light: a soft sheen across it, and where a thread lies just right between the eye and the light, a hard glint
// split into colours, as the fine ridges on real silk split it. Drawn as light added over what is behind.
export function Silk({ web, look, active }: { web: Web; look: Look; active: boolean }) {
  const size = useThree((state) => state.size);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const { mesh, material, from, to, pixel, eye, facing } = useMemo(() => {
    const count = web.segments.length;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    // Each start carries the thread's width in its fourth place.
    const from = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    const to = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    from.setUsage(THREE.DynamicDrawUsage);
    to.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aFrom", from);
    geometry.setAttribute("aTo", to);
    // The frame and spokes are dry silk, thicker; the sticky spiral finer and beaded.
    web.segments.forEach((s, i) => ((from.array as Float32Array)[i * 4 + 3] = s.kind === 2 ? 0.8 : s.kind === 0 ? 1.6 : 1.15));
    geometry.instanceCount = count;

    // The size of a pixel one unit from the eye.
    const pixel = uniform(0.001);
    // The eye and the way it looks, set each frame. The strip is turned square to the look rather than to the eye
    // point by point, which came out wrong on the GPU.
    const eye = uniform(new THREE.Vector3());
    const facing = uniform(new THREE.Vector3(0, 0, -1));
    const width = uniform(look.width);
    const silkColour = color(look.silk);
    const glint = uniform(look.glint);

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    // Built afresh for each use: a node handed to varying() is read back from the varying wherever else it appears, so
    // the vertex position and what is passed on to the fragment must not share nodes.
    const strip = () => {
      const start = attribute("aFrom", "vec4") as any;
      const a = start.xyz as any;
      const b = attribute("aTo", "vec3") as any;
      // Nudged so a broken thread, both ends at one point, still has a direction.
      const along = normalize(b.sub(a).add(vec3(1e-7, 0, 0))) as any;
      const centre = a.add(b.sub(a).mul(positionGeometry.x)) as any;
      const wanted = width.mul(start.w) as any;
      const drawn = max(wanted, length(eye.sub(centre)).mul(pixel).mul(1.1)) as any;
      // Across the thread and square to the way the camera looks.
      const f = facing as any;
      const side = normalize(vec3(along.y.mul(f.z).sub(along.z.mul(f.y)), along.z.mul(f.x).sub(along.x.mul(f.z)), along.x.mul(f.y).sub(along.y.mul(f.x)))) as any;
      return { along, centre, side, wanted, drawn };
    };
    const placed = strip();
    material.positionNode = placed.centre.add(placed.side.mul(positionGeometry.y.mul(placed.drawn).mul(0.5))) as any;
    const passed = strip();
    const tangent = varying(passed.along) as any;
    const coverage = varying(passed.wanted.div(passed.drawn)) as any;
    const edge = varying(positionGeometry.y.mul(1)) as any;

    material.colorNode = Fn(() => {
      const T = normalize(tangent) as any;
      const V = normalize(eye.sub(positionWorld)) as any;
      const L = sky.toLight as any;
      // Lit from behind, a web shines in rings round the sun: a thread catches it where it runs square to the way
      // toward the sun as seen from that point, and the fine ridges on it split that glint into colours. Elsewhere it
      // only glows faintly, more so the nearer the eye looks into the light.
      const sunward = normalize(L.sub(V.mul(dot(L, V)))) as any;
      const th = dot(T, sunward) as any;
      const square = th.mul(th).oneMinus().max(0) as any;
      const into = max(dot(V.negate(), L), 0) as any;
      const near = pow(into, 3).mul(0.8).add(0.12) as any;
      const sharp = pow(square, 600).mul(near) as any;
      const rainbow = vec3(cos(th.mul(60)), cos(th.mul(60).sub(2.094)), cos(th.mul(60).sub(4.189)))
        .mul(0.5)
        .add(0.5) as any;
      const soft = pow(square, 8).mul(0.12).add(0.05).mul(near.add(0.3)) as any;
      // Lit from in front too: a plain sheen.
      const front = pow(
        dot(T, normalize(L.add(V)))
          .abs()
          .oneMinus(),
        6
      ).mul(0.08) as any;
      const lit = silkColour.mul(soft.add(front)).add(rainbow.mul(sharp).mul(glint).mul(1.6)).add(silkColour.mul(sharp).mul(0.5)) as any;
      // Round in section: brightest down the middle of the strip.
      const round = edge.abs().oneMinus().max(0).sqrt() as any;
      return vec4(
        lit
          .mul(sky.light)
          .mul(sky.power)
          .mul(0.9)
          .mul(coverage)
          .mul(round)
          .add(vec3(1, 1, 1).mul(sky.flash.mul(coverage).mul(0.6))),
        1
      );
    })() as any;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return { mesh, material, from, to, pixel, eye, facing };
  }, [web, look]);
  useDispose(mesh.geometry, material);

  useFrame(() => {
    if (!active) return;
    eye.value.copy(camera.position);
    camera.getWorldDirection(facing.value);
    pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, size.height);
    const p = web.position;
    const f = from.array as Float32Array;
    const t = to.array as Float32Array;
    web.segments.forEach((s, i) => {
      const o = i * 3;
      const k = i * 4;
      // A broken thread is gone: both its ends drawn at one.
      const end = s.alive ? s.b : s.a;
      f[k] = p[s.a * 3];
      f[k + 1] = p[s.a * 3 + 1];
      f[k + 2] = p[s.a * 3 + 2];
      t[o] = p[end * 3];
      t[o + 1] = p[end * 3 + 1];
      t[o + 2] = p[end * 3 + 2];
    });
    from.needsUpdate = true;
    to.needsUpdate = true;
  });

  return <primitive object={mesh} />;
}
