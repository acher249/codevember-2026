import { deepEqual, equal, notEqual, ok, throws } from "node:assert/strict";
import { test } from "node:test";
import { createOutletPaints } from "./brush-colors";
import { type ColourTriple, rgbToZuv, srgbToLinear, zuvToRgb } from "./zuv";

const near = (actual: ColourTriple, expected: ColourTriple, tolerance = 2e-12) => actual.forEach((value, channel) =>
  ok(Math.abs(value - expected[channel]) <= tolerance, `channel ${channel}: ${value} differs from ${expected[channel]}`));
const encode = (linear: ColourTriple): ColourTriple => linear.map((value) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055) as [number, number, number];
const hex = (rgb: number[]) => `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;

test("outlet base retains the exact selected RGB and ZUV at every variation strength", () => {
  for (const bytes of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 0, 255], [1, 7, 13], [36, 80, 184], [128, 128, 128]]) {
    const encoded = bytes.map((value) => value / 255) as [number, number, number];
    for (const variation of [0, 0.025, 0.15, 0.8, 1]) {
      const paints = createOutletPaints(hex(bytes), variation);
      equal(paints.length, 3);
      deepEqual(paints[0].linear, srgbToLinear(encoded));
      deepEqual(paints[0].zuv, rgbToZuv(encoded));
    }
  }
  deepEqual(createOutletPaints("#F80", 0.15), createOutletPaints("#ff8800", 0.15));
});

test("zero variation preserves three stable stream IDs with one immutable exact paint", () => {
  const paints = createOutletPaints("#2450b8", 0);
  equal(paints[0], paints[1]); equal(paints[1], paints[2]);
  ok(Object.isFrozen(paints)); ok(Object.isFrozen(paints[0]));
  ok(Object.isFrozen(paints[0].linear)); ok(Object.isFrozen(paints[0].zuv));
  throws(() => { (paints[0].linear as unknown as number[])[0] = 0; }, TypeError);
  const refill = createOutletPaints("#e6b323", 0.15);
  notEqual(refill[0], paints[0]);
  deepEqual(paints[0].zuv, rgbToZuv([36 / 255, 80 / 255, 184 / 255]));
});

test("brightness companions agree with the existing ZUV Paint brush rule", () => {
  // Captured from ZUV Paint's variedLumColor(..., ±.15, artisticModel), followed by its independent core rgbToZuv.
  // The slightly wider tolerance accommodates one final bisection step in the two equivalent gamut-bound expressions.
  const fixtures: [string, ColourTriple, ColourTriple][] = [
    ["#0000ff", [0.22219999999999998, -0.2945339329155731, -0.7191218462618019], [0.03556567760407924, -0.15919841367373544, -0.3886922502604235]],
    ["#ff0000", [0.36260000000000003, 0.66135088570403, 0], [0.11722063880404461, 0.37928254210777296, 0]],
    ["#ffff00", [0.9595996104725169, -0.042427776130569125, 0.4178823808253972], [0.7777999999999999, -0.07779376394826848, 0.7662113421176663]],
    ["#2450b8", [0.4564878431372549, -0.2410931341179146, -0.3762265163657232], [0.15648784313725483, -0.2410931341179145, -0.3762265163657231]]
  ];
  for (const [colour, brighter, darker] of fixtures) {
    const paints = createOutletPaints(colour, 0.15);
    near(paints[1].zuv, brighter, 1e-10);
    near(paints[2].zuv, darker, 1e-10);
  }
});

test("Z variants preserve hue and at least 45 percent chroma, backing off only within the requested Z move", () => {
  for (const colour of ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#2450b8", "#826d58"]) {
    for (const amount of [0.025, 0.15, 0.8]) {
      const [base, brighter, darker] = createOutletPaints(colour, amount);
      const [z, u, v] = base.zuv, radius = Math.hypot(u, v);
      for (const [variant, direction] of [[brighter, 1], [darker, -1]] as const) {
        const [nextZ, nextU, nextV] = variant.zuv;
        ok((nextZ - z) * direction >= -1e-14);
        ok(Math.abs(nextZ - z) <= amount + 1e-14);
        ok(Math.abs(nextU * v - nextV * u) < 2e-12, "the ZUV hue ray cannot rotate");
        ok(nextU * u + nextV * v >= 0, "the hue ray cannot reverse");
        ok(Math.hypot(nextU, nextV) >= radius * 0.45 - 2e-12, "saturated strands retain their hue family");
        ok(Math.hypot(nextU, nextV) <= radius + 2e-12, "variation must not invent extra chroma");
      }
    }
  }
  const [blue, lighterBlue, darkerBlue] = createOutletPaints("#0000ff", 0.15);
  ok(lighterBlue.zuv[0] - blue.zuv[0] > 0.05, "saturated blue has a visibly separated lighter strand");
  ok(blue.zuv[0] - darkerBlue.zuv[0] > 0.01, "saturated blue has a visibly separated darker strand");
  ok(darkerBlue.zuv[0] > 0, "the darker blue strand does not collapse to black");
});

test("in-gamut interior variants keep their full requested Z change and signed UV", () => {
  const [base, brighter, darker] = createOutletPaints("#826d58", 0.025);
  near(brighter.zuv, [base.zuv[0] + 0.025, base.zuv[1], base.zuv[2]]);
  near(darker.zuv, [base.zuv[0] - 0.025, base.zuv[1], base.zuv[2]]);
});

test("loaded linear RGB and signed ZUV describe the same gamut-safe paint without 8-bit rounding", () => {
  let fractionalVariant = false;
  for (const r of [0, 51, 153, 255]) for (const g of [0, 85, 204, 255]) for (const b of [0, 102, 221, 255]) {
    for (const paint of createOutletPaints(hex([r, g, b]), 0.15)) {
      ok(paint.linear.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
      const raw = zuvToRgb(paint.zuv);
      ok(raw.every((value) => Number.isFinite(value) && value >= -2e-12 && value <= 1 + 2e-12));
      near(rgbToZuv(encode(paint.linear)), paint.zuv);
      fractionalVariant ||= raw.some((value) => Math.abs(value * 255 - Math.round(value * 255)) > 1e-5);
      ok(Object.isFrozen(paint) && Object.isFrozen(paint.zuv) && Object.isFrozen(paint.linear));
    }
  }
  ok(fractionalVariant, "generated paint retains precision between display-code steps");
});

test("neutral and endpoint colours remain neutral and can reach black or white", () => {
  for (const shade of [0, 1, 128, 254, 255]) {
    const [base, brighter, darker] = createOutletPaints(hex([shade, shade, shade]), 0.15);
    near(base.zuv, [shade / 255, 0, 0]);
    near(brighter.zuv, [Math.min(1, shade / 255 + 0.15), 0, 0]);
    near(darker.zuv, [Math.max(0, shade / 255 - 0.15), 0, 0]);
    for (const variant of [base, brighter, darker]) near(variant.linear, [variant.linear[0], variant.linear[0], variant.linear[0]]);
  }
});
