import { type ColourTriple, limitChroma, rgbToZuv, srgbToLinear, zuvToLinearRgb } from "./zuv";

/** One immutable paint load, shared by an outlet and every parcel emitted from it. */
export type StreamPaint = { readonly zuv: ColourTriple; readonly linear: ColourTriple };

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const GAMUT_MARGIN = 0.985;
const MIN_CHROMA = 0.45;

function immutablePaint(zuv: ColourTriple, linear: ColourTriple): StreamPaint {
  return Object.freeze({
    zuv: Object.freeze([zuv[0], zuv[1], zuv[2]]) as ColourTriple,
    linear: Object.freeze([linear[0], linear[1], linear[2]]) as ColourTriple
  });
}

function encodedHex(hex: string): ColourTriple {
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) throw new Error("Outlet paint requires a three- or six-digit RGB hex colour.");
  const digits = hex.slice(1);
  const expanded = digits.length === 3 ? digits.split("").map((digit) => digit + digit).join("") : digits;
  const value = Number.parseInt(expanded, 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}

/**
 * Load [selected colour, lighter Z variant, darker Z variant] without changing stream IDs.
 * zVariation is a requested maximum absolute change in encoded-sRGB Z, not an RGB blend or a percentage of white.
 *
 * This follows ZUV Paint's variedLumColor brush rule: preserve the hue ray, fit chroma just inside the RGB cube, and
 * back off the Z move if less than 45% of the selected chroma would survive. Saturated blues therefore keep a coloured
 * darker strand instead of collapsing to black. Neutral colours can reach black/white because they have no hue to lose.
 * Run only when the selected colour or variation changes; parcels keep these frozen, full-precision paint records.
 */
export function createOutletPaints(hex: string, zVariation: number): readonly [StreamPaint, StreamPaint, StreamPaint] {
  const encoded = encodedHex(hex);
  // Preserve the selected paint exactly: do not round-trip its RGB through the inverse or gamut projection.
  const base = immutablePaint(rgbToZuv(encoded), srgbToLinear(encoded));
  const amount = Number.isFinite(zVariation) ? clamp01(Math.abs(zVariation)) : 0;
  if (amount === 0) return Object.freeze([base, base, base]);

  const [z, u, v] = base.zuv;
  const radius = Math.hypot(u, v);
  const variant = (offset: number): StreamPaint => {
    const target = clamp01(z + offset);
    if (target === z) return base;
    if (radius < 1e-12) {
      const neutral: ColourTriple = [target, 0, 0];
      return immutablePaint(neutral, zuvToLinearRgb(neutral));
    }
    const atZ = (nextZ: number): ColourTriple => {
      // Equivalent to min(original radius, .985 * gamut-boundary radius), without changing hue or quantizing RGB.
      const fitted = limitChroma([nextZ, u / GAMUT_MARGIN, v / GAMUT_MARGIN]);
      return [fitted[0], fitted[1] * GAMUT_MARGIN, fitted[2] * GAMUT_MARGIN];
    };
    let chosen = atZ(target);
    if (Math.hypot(chosen[1], chosen[2]) < radius * MIN_CHROMA) {
      let low = 0, high = 1;
      for (let iteration = 0; iteration < 32; iteration++) {
        const fraction = (low + high) / 2;
        const candidate = atZ(z + (target - z) * fraction);
        if (Math.hypot(candidate[1], candidate[2]) >= radius * MIN_CHROMA) low = fraction;
        else high = fraction;
      }
      chosen = atZ(z + (target - z) * low);
    }
    return immutablePaint(chosen, zuvToLinearRgb(chosen));
  };
  return Object.freeze([base, variant(amount), variant(-amount)]);
}
