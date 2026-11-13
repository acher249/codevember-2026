import { Fn, If, cos, dot, float, floor, fract, length, mix, sin, sqrt, vec2, vec3, vec4 } from "three/tsl";

// One copy of the maze in metres; kept here as well as in hedge-look, which imports this file.
const SPAN = 108;

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Noise that repeats exactly once per copy of the maze, so the pattern on a hedge or a stretch of gravel is the same in
// every copy, and the camera can be carried back a whole copy without anything changing under it. Each noise is given
// how many of its cells make one copy, which has to be a whole number, and is given points in metres.

// Hoskins's hash, four numbers from 0 to 1 for a cell. No sine in it, so nothing is lost a long way from the middle.
export const hash4 = (c: any): any => {
  let p = fract(c.xyxy.mul(vec4(0.1031, 0.103, 0.0973, 0.1099))) as any;
  p = p.add(dot(p, p.wzxy.add(33.33)));
  return fract(p.xxyz.add(p.yzzw).mul(p.zywx));
};

export const hash43 = (c: any): any => {
  let p = fract(c.xyzx.mul(vec4(0.1031, 0.103, 0.0973, 0.1099))) as any;
  p = p.add(dot(p, p.wzxy.add(33.33)));
  return fract(p.xxyz.add(p.yzzw).mul(p.zywx));
};

// A whole number of cells, wrapped round into the first copy.
export const wrap = (c: any, period: any): any => c.sub(floor(c.div(period)).mul(period));

const ease = (f: any): any => f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));

// Turned about 27 degrees and stretched by the square root of five, by a matrix of whole numbers, so the grid that value
// noise is built on never lines up with the hedges, and a whole copy along still lands on a whole number of cells.
const turn2 = (p: any): any => vec2(p.x.mul(2).sub(p.y), p.x.add(p.y.mul(2)));
const turn3 = (p: any): any => vec3(p.x.mul(2).sub(p.z), p.y.mul(2.236), p.x.add(p.z.mul(2)));
// A point in metres, as cells of a noise with `cells` of them to a copy, before the turn.
const scaled = (p: any, cells: number): any => p.mul(cells / SPAN);

// Value noise across a plane, four independent ones at once for the price of one, each from -1 to 1. Its cells are about
// 2.24 times finer than `cells` to a copy would make them.
export const noise2 = (p: any, cells: number): any => cellNoise2(turn2(scaled(p, cells)), cells);
const cellNoise2 = (p: any, period: number): any => {
  const i = floor(p);
  const u = ease(fract(p));
  const at = (x: number, y: number) => hash4(wrap(i.add(vec2(x, y)), period));
  return mix(mix(at(0, 0), at(1, 0), u.x), mix(at(0, 1), at(1, 1), u.x), u.y).mul(2).sub(1);
};

// The same through space, repeating across the ground but not upward.
export const noise3 = (p: any, cells: number): any => cellNoise3(turn3(scaled(p, cells)), cells);
const cellNoise3 = (p: any, period: number): any => {
  const i = floor(p);
  const u = ease(fract(p));
  const at = (x: number, y: number, z: number) => {
    const c = i.add(vec3(x, y, z));
    return hash43(vec3(wrap(c.x, period), c.y, wrap(c.z, period)));
  };
  const near = mix(mix(at(0, 0, 0), at(1, 0, 0), u.x), mix(at(0, 1, 0), at(1, 1, 0), u.x), u.y);
  const far = mix(mix(at(0, 0, 1), at(1, 0, 1), u.x), mix(at(0, 1, 1), at(1, 1, 1), u.x), u.y);
  return mix(near, far, u.z).mul(2).sub(1);
};

// Octaves, each turned again and so about 2.24 times finer, and half as strong. Only the first of the four is kept.
export const fractal2 = (p: any, cells: number, octaves: number): any => {
  let q = turn2(scaled(p, cells));
  let sum: any = float(0);
  let weight = 0.5;
  for (let o = 0; o < octaves; o++) {
    sum = sum.add(cellNoise2(q.add(o * 17), cells).x.mul(weight));
    q = turn2(q);
    weight *= 0.5;
  }
  return sum;
};

export const fractal3 = (p: any, cells: number, octaves: number): any => {
  let q = turn3(scaled(p, cells));
  let sum: any = float(0);
  let weight = 0.5;
  for (let o = 0; o < octaves; o++) {
    sum = sum.add(cellNoise3(q.add(o * 17), cells).x.mul(weight));
    q = turn3(q);
    weight *= 0.5;
  }
  return sum;
};

// Leaves: cells of a jittered grid, each turned `base` give or take half of `spread`, and `long` times as long as it is
// wide. Gives how far along and across the nearest cell's middle the point lies, the way it is turned, and a number from
// 0 to 1 of its own.
export const leafCells = (long: number) =>
  Fn(([p, period, base, spread]: [any, any, any, any]) => {
    // Only the four cells round the nearest corner are looked at, which holds while no middle strays more than a quarter
    // cell from its own: a little more regular than leaves are, and a good deal cheaper.
    const start = floor(p.sub(0.5));
    const f = p.sub(start);
    const best = float(9).toVar();
    const along = float(0).toVar();
    const across = float(0).toVar();
    const turn = float(0).toVar();
    const own = float(0).toVar();
    for (let y = 0; y <= 1; y++) {
      for (let x = 0; x <= 1; x++) {
        const h = hash4(wrap(start.add(vec2(x, y)), period));
        const d = vec2(x, y).add(h.xy.mul(0.5).add(0.25)).sub(f) as any;
        const angle = base.add(h.z.sub(0.5).mul(spread));
        const c = cos(angle);
        const s = sin(angle);
        const lengthwise = d.x.mul(c).add(d.y.mul(s));
        const sideways = d.y.mul(c).sub(d.x.mul(s));
        const distance = lengthwise.mul(lengthwise).add(sideways.mul(sideways).mul(long * long));
        If(distance.lessThan(best), () => {
          best.assign(distance);
          along.assign(lengthwise);
          across.assign(sideways);
          turn.assign(angle);
          own.assign(h.w);
        });
      }
    }
    return vec4(along, across, turn, own);
  });

// Stones: the distance to the nearest cell's middle, the gap to the next nearest, and two numbers of the cell's own.
export const stoneCells = (long: number, wide = true) =>
  Fn(([p, period]: [any, any]) => {
    // Narrow looks at only the four cells round the nearest corner, as the leaves do, for small stones that can be a
    // little more regular.
    const start = wide ? floor(p) : floor(p.sub(0.5));
    const f = p.sub(start);
    const from = wide ? -1 : 0;
    const jitter = wide ? 0.8 : 0.5;
    const best = float(9).toVar();
    const second = float(9).toVar();
    const own = vec2(0).toVar();
    for (let y = from; y <= 1; y++) {
      for (let x = from; x <= 1; x++) {
        const h = hash4(wrap(start.add(vec2(x, y)), period));
        const d = vec2(x, y).add(h.xy.mul(jitter).add((1 - jitter) / 2)).sub(f) as any;
        const c = h.z.mul(2).sub(1);
        const s = sqrt(float(1).sub(c.mul(c)));
        const lengthwise = d.x.mul(c).add(d.y.mul(s));
        const sideways = d.y.mul(c).sub(d.x.mul(s));
        const distance = lengthwise.mul(lengthwise).add(sideways.mul(sideways).mul(long * long));
        If(distance.lessThan(best), () => {
          second.assign(best);
          best.assign(distance);
          own.assign(h.wz);
        }).ElseIf(distance.lessThan(second), () => {
          second.assign(distance);
        });
      }
    }
    const near = sqrt(best);
    return vec4(near, sqrt(second).sub(near), own);
  });

export const leafLength = (cell: any, long: number): any => length(vec2(cell.x, cell.y.mul(long)));
