"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { abs, acos, atan, Break, clamp, cos, dot, float, floor, Fn, fract, If, length, log, Loop, max, min, mix, pow, reflect, sin, smoothstep, sqrt, uniform, vec2, vec3, vec4 } from "three/tsl";
import { useQuality } from "../shared/engine/quality";
import { useSettingRef } from "../shared/engine/settings";
import { useLook } from "../shared/engine/Stage";
import { type FormName, GAP, GAP_GROWTH, gooOf, JOINTS, Parts, TUNED_SIZE } from "./forms";
import { makeHall, shadeSurface, useFinish } from "./finish";
import { Turning, useStudyView } from "./four";
import { makeMarcher, MarchedShell, useMarchedMaterial } from "./marching";
import { SPEED_UNIT, usePulse } from "./pulse";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const CENTRE: [number, number, number] = [0, 3.6, 0];
const FAR = 90;
// How far the tubes and joints flow into each other.
const MELT = 0.34;
const RING_TUBE = 0.11;
// How big a Hearts joint is on the 3-sphere for one unit of its fractal, which reaches about 1.2, and how far short of it the bars stop.
const HEART = 0.2;
const HEART_GAP = 0.31;
// Needles are steep, so a ray steps this much of the distance while among them.
const NEEDLE_STEP = 0.2;

// The tesseract's edges drawn on the 3-sphere and brought down by stereographic projection, so straight 4D edges arrive as circles.
// Turning it carries the inner cube out through the outer one, and `Turning` picks the turns that keep the whole thing on screen.
export function Hypercube({ form }: { form: FormName }) {
  const { tier } = useQuality();
  const speedKey = `${form}Speed`;
  const { time, pointer, stir } = usePulse("hum", 0.12, speedKey);
  const was = useRef({ x: 0, y: 0 });
  const look = useFinish("cube", gooOf(form) ? 1 : 0.25);
  const speed = useSettingRef<number>(speedKey);
  const thicknesses = {
    one: useSettingRef<number>("cubeThickness"),
    rings: useSettingRef<number>("ringsThickness"),
    heart: useSettingRef<number>("heartThickness"),
    urchin: useSettingRef<number>("urchinThickness")
  };
  const size = useSettingRef<number>(`${form}Size`);
  const turning = useMemo(() => new Turning(), []);
  const shape = useMemo(() => ({ thickness: uniform(1) as any, size: uniform(1.35) as any }), []);
  const parts = useMemo(() => new Parts(form), [form]);
  useStudyView([3.5, 4.4, 17], CENTRE);
  // No screen-space occlusion: the shader works out its own, and the pass read the open sky as a floor, drawing a faint
  // line along the horizon and speckle under it.
  useLook({ background: "#07050f", exposure: 1, bloom: 0.2, bloomThreshold: 1.3, ao: 0, aoRadius: 0.5, vignette: 0.42, grain: 0.012 });
  useFrame((_, delta) => {
    // Dragging pushes it through the turn, either way, and it leans to follow. Both are safe: see Turning.
    const { x, y } = pointer.value;
    turning.progress += (x - was.current.x) * 0.2 + (y - was.current.y) * 0.13;
    was.current.x = x;
    was.current.y = y;
    turning.lean[0] = x * 0.55;
    turning.lean[1] = -y * 0.55;
    const pace = speed.current * SPEED_UNIT;
    turning.update(Math.min(delta, 0.05), pace);
    parts.update(Math.min(delta, 0.05), pace, size.current, turning.matrix.value);
    shape.thickness.value = thicknesses[form].current * (1 + stir.value * 0.35);
    shape.size.value = size.current;
  });

  // The extra parts ask much more of every step, so they take fewer.
  const crowded = form !== "one";
  const primary = gooOf(form)?.thorn ? (tier === "high" ? 120 : tier === "medium" ? 90 : 64) : crowded ? (tier === "high" ? 72 : tier === "medium" ? 56 : 48) : tier === "high" ? 96 : tier === "medium" ? 56 : 36;
  const bounce = crowded ? (tier === "high" ? 16 : tier === "medium" ? 10 : 0) : tier === "high" ? 34 : tier === "medium" ? 20 : 0;
  const shadows = crowded ? (tier === "low" ? 6 : 12) : tier === "low" ? 10 : 22;

  const material = useMarchedMaterial(
    (ro, rd, _out, finish) => {
      const R = turning.matrix;
      const centre = vec3(...CENTRE) as any;
      const fractalTurns = tier === "high" ? 11 : tier === "medium" ? 9 : 7;
      // A Mandelbulb: z² + c again, but with the power raised and worked out in spherical coordinates.
      const bulb = Fn(([at]: any[]) => {
        const q = vec3(at.x.mul(parts.turn.x).sub(at.z.mul(parts.turn.y)), at.y, at.x.mul(parts.turn.y).add(at.z.mul(parts.turn.x))).toVar() as any;
        const w = q.toVar() as any;
        const slope = float(1).toVar() as any;
        const size = length(w).toVar() as any;
        Loop(Math.min(fractalTurns - 2, 7), () => {
          size.assign(length(w));
          If(size.greaterThan(2), () => {
            Break();
          });
          slope.assign(pow(size, parts.power.sub(1)).mul(parts.power).mul(slope).add(1));
          const theta = acos(clamp(w.y.div(size.add(0.00001)), -1, 1)).mul(parts.power) as any;
          const phi = atan(w.z, w.x).mul(parts.power) as any;
          w.assign(vec3(sin(theta).mul(cos(phi)), cos(theta), sin(theta).mul(sin(phi))).mul(pow(size, parts.power)).add(q));
        });
        return log(max(size, float(1.0001))).mul(size).mul(0.5).div(slope).mul(0.8);
      }).setLayout({ name: `${form}Bulb`, type: "float", inputs: [{ name: "at", type: "vec3" }] }) as any;
      // Ferrofluid: a needle for every cell of a grid wrapped around the field, each with its own height and breath. They have sharp tips and hollow
      // skirts, and fall to nothing at the edge of the cell, so that cells, and the faces of the grid, meet without a seam.
      const needles = Fn(([at, cells, clock]: any[]) => {
        const n = at.div(length(at).add(0.0001)).toVar() as any;
        const a = abs(n).toVar() as any;
        const face = vec2(n.y, n.z).div(a.x).toVar() as any;
        const side = float(1).toVar() as any;
        If(a.y.greaterThan(a.x).and(a.y.greaterThan(a.z)), () => {
          face.assign(vec2(n.x, n.z).div(a.y));
          side.assign(2);
        }).ElseIf(a.z.greaterThan(a.x), () => {
          face.assign(vec2(n.x, n.y).div(a.z));
          side.assign(3);
        });
        // Evens out the grid, which would otherwise be stretched towards the corners of a face.
        // With an odd number of cells, a half-cell shift keeps the edge of a face on the edge of a cell.
        const even = vec2(atan(face.x, float(1)), atan(face.y, float(1))).mul(1.27324).mul(cells.mul(0.5)).add(fract(cells.mul(0.5))).toVar() as any;
        const cell = fract(even).sub(0.5).toVar() as any;
        const lump = float(1).sub(length(cell).mul(2)).toVar() as any;
        const tip = max(lump, float(0)) as any;
        const seed = (dot as any)(floor(even), vec2(12.9898, 78.233)).add(side.mul(37.7)) as any;
        const luck = fract(sin(seed).mul(43758.5453)) as any;
        const breath = sin(clock.mul(2).add(luck.mul(6.283))).mul(0.25).add(luck.mul(0.35)).add(0.65) as any;
        return tip.mul(tip).mul(breath);
      }).setLayout({ name: `${form}Needles`, type: "float", inputs: [{ name: "at", type: "vec3" }, { name: "cells", type: "float" }, { name: "clock", type: "float" }] }) as any;
      const cube = Fn(([at]: any[]) => {
        const scale = shape.size;
        const thick = shape.thickness;
        const melt = float(MELT);
        const p = at.div(scale) as any;
        const r2 = dot(p, p) as any;
        const lifted = R.mul(vec4(p.mul(2), r2.sub(1)).div(r2.add(1))).toVar() as any;
        const X = lifted.abs() as any;
        // Squared distance from the folded point to one arc, with x as the free axis, stopping at the corner. Sums of squared
        // differences, because 2 - 2cos loses all its precision when the answer is tiny, which reads as sand on the far tubes.
        const toCorner = (x: any, a: any, b: any, c: any) => (x.sub(0.5) as any).pow2().add(a.sub(0.5).pow2()).add(b.sub(0.5).pow2()).add(c.sub(0.5).pow2());
        const toArc = (x: any, a: any, b: any, c: any) => {
          const off = a.sub(b).pow2().add(b.sub(c).pow2()).add(c.sub(a).pow2()).div(3) as any;
          return mix(off.add(off.mul(off).mul(0.25)), toCorner(x, a, b, c), smoothstep(-0.03, 0.03, x.sub(a.add(b).add(c).div(3))));
        };
        // A soft minimum, so that tubes flow into each other instead of meeting at a crease.
        const flow = float(MELT * 0.05 + 0.006) as any;
        const soften = (a: any, b: any) => {
          const h = clamp(float(0.5).add(b.sub(a).mul(0.5).div(flow)), 0, 1) as any;
          return mix(b, a, h).sub(flow.mul(h).mul(float(1).sub(h)));
        };
        const nearest = soften(soften(toArc(X.x, X.y, X.z, X.w), toArc(X.y, X.x, X.z, X.w)), soften(toArc(X.z, X.x, X.y, X.w), toArc(X.w, X.x, X.y, X.z))) as any;
        // Keeps falling inside a tube rather than going flat, so a ray that overshoots the skin still finds a direction to light.
        const chord = nearest.div(sqrt(abs(nearest).add(0.000001))) as any;
        const corner = sqrt(toCorner(X.x, X.y, X.z, X.w).add(0.000000001)) as any;
        const r = sqrt(r2) as any;
        const root = sqrt(r2.add(1)) as any;
        // Close to an arc the projection's stretch is (1 + r²) / 2. Elsewhere only the square root of that is safe, and nothing is out past 3.2.
        const safe = max(smoothstep(0, 0.7, chord), smoothstep(3.4, 5, r)) as any;
        const stretch = root.mul(0.5).mul(scale).mul(mix(root, float(1), safe)) as any;
        const swell = pow(r2.add(1), float(0.2)).mul(thick) as any;
        const edge = chord.mul(stretch).sub(swell.mul(0.1)) as any;
        const joint = corner.mul(stretch).sub(swell.mul(0.19)) as any;
        const h = clamp(float(0.5).add(joint.sub(edge).mul(0.5).div(melt)), 0, 1) as any;
        const joined = mix(joint, edge, h).sub(melt.mul(h).mul(float(1).sub(h))) as any;
        if (form === "one") return joined.mul(0.74);
        // Every bar stops short of a joint, with a slightly rounded end.
        const stopped = (clear: any) => {
          const round = float(0.05);
          const m = clamp(float(0.5).add(edge.sub(clear).mul(0.5).div(round)), 0, 1) as any;
          return mix(clear, edge, m).add(round.mul(m).mul(float(1).sub(m)));
        };
        if (form === "heart") {
          // A fractal in every gap. The fold brings all 16 corners onto one, so this is one fractal, seen 16 times.
          const body = corner.sub(HEART * 1.35).mul(stretch).toVar() as any;
          If(body.lessThan(0.25), () => {
            const d = X.sub(0.5).toVar() as any;
            const q = vec3(d.x.add(d.y).sub(d.z).sub(d.w), d.x.sub(d.y).add(d.z).sub(d.w), d.x.sub(d.y).sub(d.z).add(d.w)).mul(0.5 / HEART).toVar() as any;
            body.assign(bulb(q).mul(HEART).mul(stretch));
          });
          return min(stopped(float(HEART_GAP).sub(corner).mul(stretch)), body).mul(0.74);
        }
        return stopped(float(GAP).mul(scale.div(TUNED_SIZE)).mul(pow(r2.add(1), float(GAP_GROWTH))).sub(corner.mul(stretch))).mul(0.74);
      }).setLayout({ name: `${form}Cube`, type: "float", inputs: [{ name: "at", type: "vec3" }] }) as any;
      const ring = (at: any, axis: any, radius: any, tube: any) => {
        const along = dot(at, axis) as any;
        const across = sqrt(max(dot(at, at).sub(along.mul(along)), float(0))) as any;
        return sqrt(across.sub(radius).pow2().add(along.mul(along))).sub(tube);
      };
      const tools = makeMarcher(`cube${form}`, (position: any) => {
        const at = position.sub(centre).toVar() as any;
        const blobs = gooOf(form);
        if (blobs) {
          const goo = float(1000).toVar() as any;
          Loop(blobs.balls, ({ i }: any) => {
            const ball = parts.ballsNode.element(i) as any;
            const d = length(at.sub(ball.xyz)).sub(ball.w.mul(shape.thickness)).toVar() as any;
            const h = clamp(float(0.5).add(goo.sub(d).mul(0.5).div(blobs.flow)), 0, 1).toVar() as any;
            goo.assign(mix(goo, d, h).sub(float(blobs.flow).mul(h).mul(float(1).sub(h))));
          });
          const churn = time.mul(0.3) as any;
          // A swell through the whole mass, so that the surface is never still. It can change the distance this fast, so steps shrink to suit.
          const swell = sin(at.x.mul(2.2).add(churn)).mul(sin(at.y.mul(2.6).sub(churn))).mul(sin(at.z.mul(2.4).add(churn.mul(0.7)))).mul(blobs.swell) as any;
          const soft = goo.add(swell).mul(1 / (1 + blobs.swell * 3)).toVar() as any;
          const { thorn } = blobs;
          if (thorn) {
            // Spikes only ever add to the mass, so away from it the field is simply the mass, less the tallest they can be.
            const tallest = thorn.height;
            const out = soft.sub(tallest).toVar() as any;
            If(soft.lessThan(tallest + 0.3), () => {
              out.assign(soft.sub(needles(at, float(thorn.cells), churn).mul(thorn.height)).mul(NEEDLE_STEP));
            });
            return out;
          }
          return soft;
        }
        const best = cube(at).toVar() as any;
        if (form === "rings") {
          Loop(JOINTS, ({ i }: any) => {
            const place = parts.ringsNode.element(i) as any;
            const here = at.sub(place.xyz).toVar() as any;
            const radius = place.w.toVar() as any;
            // Nothing of it can be closer than the sphere it spins in, which saves working out both rings for most joints.
            If(length(here).sub(radius.mul(1.12)).lessThan(best), () => {
              best.assign(min(best, ring(here, parts.axesNode.element(i.mul(2)), radius, radius.mul(RING_TUBE))));
              best.assign(min(best, ring(here, parts.axesNode.element(i.mul(2).add(1)), radius.mul(0.74), radius.mul(RING_TUBE * 0.74))));
            });
          });
        }
        return best;
      });

      const hall = makeHall("cube", look, time);
      const march = tools.march("Primary", primary);
      const marchBounce = bounce > 0 ? tools.march("Bounce", bounce) : null;
      const shadow = tools.softShadow(shadows);
      const zero = float(0);
      const distance = march(ro, rd, float(0.02), float(FAR), zero).toVar() as any;
      const colour = hall(rd).mul(look.sky).add(vec3(0.005, 0.004, 0.012)).toVar() as any;
      const normal = vec3(0, 1, 0).toVar() as any;
      If(distance.greaterThan(0), () => {
        const point = ro.add(rd.mul(distance)).toVar() as any;
        normal.assign(tools.normalAt(point, zero));
        const off = reflect(rd, normal).toVar() as any;
        const reflected = hall(off).toVar() as any;
        const lifted = point.add(normal.mul(0.02)).toVar() as any;
        if (marchBounce) {
          const hit = marchBounce(lifted, off, float(0.03), float(14), zero) as any;
          reflected.mulAssign(hit.greaterThan(0).select(float(0.42), float(1)));
        }
        colour.assign(
          shadeSurface({
            look,
            normal,
            ray: rd,
            band: point.sub(centre).length().mul(0.12).add(time.mul(0.016)),
            reflected,
            held: tools.occlusion(point, normal, zero),
            lit: shadow(lifted, look.key, float(9), zero)
          })
        );
      });
      finish(distance, normal);
      return min(colour, vec3(30));
    },
    [form, tier, parts, turning, shape, look, time, primary, bounce, shadows]
  );

  return <MarchedShell material={material} />;
}
