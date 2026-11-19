import { deepEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { ColourTriple, limitChroma, rgbToZuv, srgbToLinear, zuvToDisplayRgb, zuvToLinearRgb, zuvToRgb } from "./zuv";

const near = (actual: ColourTriple, expected: ColourTriple, tolerance = 1e-12) => {
  actual.forEach((value, channel) => ok(Math.abs(value - expected[channel]) <= tolerance,
    `channel ${channel}: ${value} differs from ${expected[channel]}`));
};
const mix = (a: ColourTriple, b: ColourTriple, t: number): ColourTriple => [
  a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])
];

// Reference values from zuv-core.js, makeModel({ A: [.2126,.7152,.0722], tau: .5726 }).
// These are encoded RGB, with neither a transfer function nor gamut clipping.
test("artistic forward transform agrees with independent core fixtures", () => {
  const fixtures: [ColourTriple, ColourTriple][] = [
    [[1, 0, 0], [0.21260000000000004, 0.8428500934329901, 0]],
    [[0, 1, 0], [0.7152, -0.7890058603049437, 0.693976132445818]],
    [[0, 0, 1], [0.0722, -0.35377425257948025, -0.8637605560639071]],
    [[1, 1, 0], [0.9278, -0.094283946932321, 0.9286275127040245]],
    [[0, 1, 1], [0.7873999999999999, -0.7976090592107887, -0.2724262628031309]],
    [[1, 0, 1], [0.2848, 0.595863954872137, -0.8654936552535415]]
  ];
  for (const [rgb, expected] of fixtures) near(rgbToZuv(rgb), expected);
});

test("RGB grid round-trips and gray remains neutral", () => {
  for (let r = 0; r <= 10; r++) for (let g = 0; g <= 10; g++) for (let b = 0; b <= 10; b++) {
    const rgb: ColourTriple = [r / 10, g / 10, b / 10];
    near(zuvToRgb(rgbToZuv(rgb)), rgb);
    near(zuvToDisplayRgb(rgbToZuv(rgb)), rgb);
  }
  for (const gray of [0, 0.01, 0.18, 0.5, 0.9, 1]) near(rgbToZuv([gray, gray, gray]), [gray, 0, 0]);
});

test("Cartesian mixtures match core fixtures and retain signed out-of-gamut colour", () => {
  const fixtures: [ColourTriple, ColourTriple, ColourTriple][] = [
    [[0, 0, 1], [1, 1, 0], [0.28363741910594686, 0.5655009786231109, 0.4882601771028648]],
    [[1, 0, 0], [0, 1, 0], [0.4618103933786975, 0.49947052785157564, 0.11769790648534595]],
    [[0, 1, 0], [0, 0, 1], [-0.13996884951188743, 0.5351845339203626, 0.5636204812518557]],
    [[0, 1, 1], [1, 0, 1], [0.4625565764238542, 0.5002167108967325, 1.1081091443067237]]
  ];
  for (const [a, b, expected] of fixtures) near(zuvToRgb(mix(rgbToZuv(a), rgbToZuv(b), 0.5)), expected);
  const blue = rgbToZuv([0, 0, 1]);
  ok(blue[1] < 0 && blue[2] < 0, "signed UV must survive storage");
  const outside: ColourTriple = [0.4, -1.2, 0.8];
  near(rgbToZuv(zuvToRgb(outside)), outside);
});

test("display mapping preserves Z and hue, only reducing chroma to the gamut boundary", () => {
  for (const pair of [
    [[0, 1, 0], [0, 0, 1]],
    [[0, 1, 1], [1, 0, 1]]
  ] as [ColourTriple, ColourTriple][]) {
    const raw = mix(rgbToZuv(pair[0]), rgbToZuv(pair[1]), 0.5);
    const before = [...raw];
    const mapped = limitChroma(raw);
    const rgb = zuvToDisplayRgb(raw);
    const measured = rgbToZuv(rgb);
    near(measured, mapped);
    ok(Math.abs(mapped[0] - raw[0]) < 1e-12, "Z is preserved");
    ok(Math.abs(mapped[1] * raw[2] - mapped[2] * raw[1]) < 1e-12, "hue direction is preserved");
    ok(mapped[1] * raw[1] + mapped[2] * raw[2] > 0, "hue direction is not reversed");
    ok(Math.hypot(mapped[1], mapped[2]) < Math.hypot(raw[1], raw[2]), "chroma decreases");
    ok(rgb.every(channel => channel >= 0 && channel <= 1));
    ok(rgb.some(channel => Math.min(channel, 1 - channel) < 1e-12), "maximum fitting chroma reaches the cube");
    deepEqual(raw, before, "display projection cannot change stored paint");
  }
  const inside = rgbToZuv([0.15, 0.4, 0.75]);
  deepEqual(limitChroma(inside), inside);
  near(zuvToDisplayRgb([0, 0, 0]), [0, 0, 0]);
  near(zuvToDisplayRgb([-0.1, 0.5, -0.3]), [0, 0, 0]);
  near(zuvToDisplayRgb([1.1, 0.5, -0.3]), [1, 1, 1]);
});

test("multiway weighted ZUV mixing is independent of grouping before display projection", () => {
  const [a, b, c] = [[0, 1, 1], [1, 0, 1], [1, 1, 0]].map(rgb => rgbToZuv(rgb as [number, number, number]));
  const weights = [2, 3, 5];
  const direct: ColourTriple = [0, 1, 2].map(channel =>
    (a[channel] * weights[0] + b[channel] * weights[1] + c[channel] * weights[2]) / 10
  ) as [number, number, number];
  near(mix(mix(a, b, 3 / 5), c, 5 / 10), direct);
  near(mix(a, mix(b, c, 5 / 8), 8 / 10), direct);
});

test("encoded RGB is decoded exactly once for the physical material", () => {
  near(srgbToLinear([0, 0.04045, 1]), [0, 0.0031308049535603713, 1]);
  near(zuvToLinearRgb(rgbToZuv([0.5, 0.5, 0.5])), [0.21404114048223255, 0.21404114048223255, 0.21404114048223255]);
  near(zuvToLinearRgb(rgbToZuv([1, 0, 0])), [1, 0, 0]);
});
