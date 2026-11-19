// The artistic ZUV model used by ZUV Paint. RGB here means encoded sRGB in [0, 1],
// before the transfer to linear light used by Three's materials.
export type ColourTriple = readonly [number, number, number];
export type MutableColourTriple = [number, number, number];

// The canonical basis is derived from A and red: p1 = normalize(A),
// p2 = normalize(red - zRed * white), p3 = cross(p1, p2).
// These constants are shared with the shader; tau is measured in radians per Z.
export const ZUV_ARTISTIC = Object.freeze({
  A: [0.2126, 0.7152, 0.0722] as const,
  tau: 0.5726,
  zRed: 0.2126,
  p2: [0.9342112033147701, -0.2522393977961902, -0.2522393977961902] as const,
  p3: [-0.21636431230692724, 0.16151777343957513, -0.9628595397165012] as const
});

const dot = (a: ColourTriple, b: ColourTriple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Convert encoded sRGB to signed Cartesian ZUV. No gamut mapping occurs here. */
export function rgbToZuv(rgb: ColourTriple): MutableColourTriple {
  const { A, p2, p3, tau, zRed } = ZUV_ARTISTIC;
  const z = dot(rgb, A);
  const centered: ColourTriple = [rgb[0] - z, rgb[1] - z, rgb[2] - z];
  const beta = dot(centered, p2);
  const gamma = dot(centered, p3);
  const angle = tau * (z - zRed);
  const c = Math.cos(angle), s = Math.sin(angle);
  return [z, c * beta - s * gamma, s * beta + c * gamma];
}

/** The raw inverse. Out-of-gamut results remain available to later mixtures. */
export function zuvToRgb(zuv: ColourTriple): MutableColourTriple {
  const { p2, p3, tau, zRed } = ZUV_ARTISTIC;
  const [z, u, v] = zuv;
  const angle = -tau * (z - zRed);
  const c = Math.cos(angle), s = Math.sin(angle);
  const beta = c * u - s * v, gamma = s * u + c * v;
  return [
    z + p2[0] * beta + p3[0] * gamma,
    z + p2[1] * beta + p3[1] * gamma,
    z + p2[2] * beta + p3[2] * gamma
  ];
}

/**
 * Fit the display colour to the RGB cube by shortening its UV ray. For valid
 * paint mixtures Z stays in [0, 1]; only chroma changes, preserving Z and hue.
 * This projection never feeds back into the stored paint. Invalid end slices
 * have no chromatic in-gamut equivalent and resolve to black or white.
 */
export function limitChroma(zuv: ColourTriple): MutableColourTriple {
  const [z, u, v] = zuv;
  if (z <= 0) return [0, 0, 0];
  if (z >= 1) return [1, 0, 0];
  const rgb = zuvToRgb(zuv);
  let scale = 1;
  for (const channel of rgb) {
    const delta = channel - z;
    if (delta > 0) scale = Math.min(scale, (1 - z) / delta);
    else if (delta < 0) scale = Math.min(scale, -z / delta);
  }
  return [z, u * scale, v * scale];
}

/** Encoded sRGB for display; the final clamp removes floating-point roundoff. */
export function zuvToDisplayRgb(zuv: ColourTriple): MutableColourTriple {
  const rgb = zuvToRgb(limitChroma(zuv));
  return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
}

/** Decode sRGB exactly once before lighting. The caller supplies in-gamut RGB. */
export function srgbToLinear(rgb: ColourTriple): MutableColourTriple {
  const decode = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return [decode(rgb[0]), decode(rgb[1]), decode(rgb[2])];
}

export function zuvToLinearRgb(zuv: ColourTriple): MutableColourTriple {
  return srgbToLinear(zuvToDisplayRgb(zuv));
}
