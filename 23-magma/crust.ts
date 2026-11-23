// The pastry's crust, baked once at load on the graphics card into two textures over the pocket's own top (planar, u
// along its length, v across): colour and roughness, and the surface's height with its slopes. Matched to a photo
// of a whole pocket: pale creamy dough, close to raw-looking; craggy like biscuit dough, with small and medium pits,
// torn and stretched strands and fissures along the sides; toasted only in golden-orange freckles on the raised peaks,
// thickest along the top ridge, the ends and the bottom edge; sparse dark herb and pepper flecks; matte and floury.
//
// The pocket's mesh is displaced by the height (real relief, so the pits and crags shade and shadow) and lit by the
// slopes, so all of this reads at the default distance, not only close up. Baked at 4096 × 2048 on High and Medium and
// 2048 × 1024 on Low, with mipmaps: no noise runs per pixel per frame.

import * as THREE from "three/webgpu";
import { abs, clamp, exp, float, Fn, max, min, mix, mx_cell_noise_float, mx_fractal_noise_float, mx_noise_float, mx_worley_noise_float, sin, smoothstep, step, uv, vec2, vec3, vec4 } from "three/tsl";
import { LIP, POCKET } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// How high the relief stands, at most, in the pocket's units (one is 25 cm): about 2 mm of lumps and pits.
export const RELIEF = 0.008;

// How far inside the outline a point is (positive inside), as outline() on the processor.
const depthAt = (x: any, z: any) => {
  const hx = POCKET.length / 2 - POCKET.corner;
  const hz = POCKET.width / 2 - POCKET.corner;
  const q = vec2(abs(x).sub(hx), abs(z).sub(hz)) as any;
  return vec2(max(q.x, 0), max(q.y, 0))
    .length()
    .add(min(max(q.x, q.y), 0))
    .sub(POCKET.corner)
    .negate() as any;
};

// The crust's height at a point of the pocket's top (its own x, z): big lumps, medium pits, small pits, fissures along
// the sides, and fine crumb. Zero on average; the pits go down further than the lumps rise.
function height(x: any, z: any) {
  const p = vec3(x, 0, z) as any;
  const lumps = mx_fractal_noise_float(p.mul(9)).mul(0.45) as any;
  // Pits: round hollows at random spots, each the size of a cell (medium about 6 mm, small about 2 mm), not every cell.
  const medium = mx_worley_noise_float(vec3(x.mul(46), z.mul(46), 1.3)) as any;
  const mediumPick = step(0.42, mx_cell_noise_float(vec3(x.mul(46), z.mul(46), 1.3).floor())) as any;
  const small = mx_worley_noise_float(vec3(x.mul(130), z.mul(130), 7.1)) as any;
  const smallPick = step(0.5, mx_cell_noise_float(vec3(x.mul(130), z.mul(130), 7.1).floor())) as any;
  const pits = smoothstep(0.42, 0.04, medium)
    .mul(mediumPick)
    .mul(0.75)
    .add(smoothstep(0.34, 0.04, small).mul(smallPick).mul(0.4)) as any;
  // Torn, stretched dough along the sides: short fissures running along the length where the noise crosses zero.
  const d = depthAt(x, z) as any;
  const sides = smoothstep(0.09, 0.02, d) as any;
  const tear = float(1)
    .sub(smoothstep(0, 0.05, abs(mx_noise_float(vec3(x.mul(26), z.mul(90), 4.4)))))
    .mul(smoothstep(0.1, 0.5, mx_noise_float(vec3(x.mul(8), z.mul(8), 9)))) as any;
  const crumb = mx_fractal_noise_float(p.mul(420)).mul(0.12) as any;
  const strands = sin(x.mul(260).add(mx_noise_float(p.mul(40)).mul(6)))
    .mul(0.06)
    .mul(sides) as any;
  return (
    lumps
      .sub(pits)
      .sub(tear.mul(sides).mul(0.6))
      // The seam is rougher still: more crumb along it.
      .add(crumb.mul(sides.mul(1.6).add(1)))
      .add(strands)
      .mul(RELIEF * 0.5) as any
  );
}

// The pastry's puff over a point, 0 at the seam to 1 on top, as topHeight() on the processor without its lumps.
const puffAt = (d: any) => float(1).sub(exp(max(d.sub(LIP * 0.3), 0).div(-0.035))) as any;

export type Crust = { colour: THREE.Texture; surface: THREE.Texture; bake: (renderer: THREE.WebGPURenderer) => void; dispose: () => void; baked: boolean; passes: number; checking: boolean };

export function createCrust(fine: boolean): Crust {
  const width = fine ? 4096 : 2048;
  const tall = fine ? 2048 : 1024;
  const options = { generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
  const colourTarget = new THREE.RenderTarget(width, tall, { ...options, type: THREE.UnsignedByteType });
  const surfaceTarget = new THREE.RenderTarget(width, tall, { ...options, type: THREE.HalfFloatType });
  for (const t of [colourTarget.texture, surfaceTarget.texture]) {
    t.anisotropy = 8;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  }

  // Where a texel is on the pocket: uv over its length and width.
  const at = () => {
    const t = uv() as any;
    return { x: t.x.sub(0.5).mul(POCKET.length) as any, z: t.y.sub(0.5).mul(POCKET.width) as any };
  };

  const surfaceMaterial = new THREE.MeshBasicNodeMaterial({ toneMapped: false });
  surfaceMaterial.colorNode = Fn(() => {
    const { x, z } = at();
    // Slopes by differences a texel apart: the height in r, its slope along x and z in g and b.
    const e = POCKET.length / width;
    const h = height(x, z) as any;
    const gx = height(x.add(e), z)
      .sub(height(x.sub(e), z))
      .div(2 * e) as any;
    const gz = height(x, z.add(e))
      .sub(height(x, z.sub(e)))
      .div(2 * e) as any;
    return vec4(h, gx, gz, 1);
  })() as any;

  const colourMaterial = new THREE.MeshBasicNodeMaterial({ toneMapped: false });
  colourMaterial.colorNode = Fn(() => {
    const { x, z } = at();
    const p = vec3(x, 0, z) as any;
    const h = height(x, z).div(RELIEF * 0.5) as any;
    const d = depthAt(x, z) as any;
    const puff = puffAt(d) as any;
    // Baked golden orange-tan (as in a photo of one), warmer and browner toward the edges and corners.
    const edgeBrown = smoothstep(0.07, 0.0, d)
      .add(smoothstep(POCKET.length / 2 - 0.06, POCKET.length / 2, abs(x)).mul(0.6))
      .min(1) as any;
    let c: any = mix(vec3(0.88, 0.64, 0.36), vec3(0.8, 0.53, 0.26), smoothstep(-0.3, 0.6, mx_fractal_noise_float(p.mul(7))));
    c = mix(c, vec3(0.62, 0.36, 0.15), edgeBrown.mul(0.7));
    // A faint floury bloom and grain.
    c = c.add(mx_fractal_noise_float(p.mul(300)).mul(0.03));
    // Toasting on the raised peaks: thickest on the top ridge, the ends and the edge.
    const ridge = puff.mul(smoothstep(0.06, 0.0, abs(z))) as any;
    const ends = smoothstep(POCKET.length / 2 - 0.09, POCKET.length / 2 - 0.01, abs(x)) as any;
    const seam = smoothstep(0.05, 0.0, d) as any;
    const region = clamp(ridge.add(ends).add(seam.mul(0.9)).add(0.4), 0, 1) as any;
    const peak = smoothstep(-0.1, 0.5, h) as any;
    // Darker browned spots and blisters, a few, of many sizes.
    const f1 = mx_worley_noise_float(vec3(x.mul(150), z.mul(150), 2.2)) as any;
    const f1Pick = step(0.3, mx_cell_noise_float(vec3(x.mul(150), z.mul(150), 2.2).floor())) as any;
    const f2 = mx_worley_noise_float(vec3(x.mul(55), z.mul(55), 5.6)) as any;
    const f2Pick = step(0.55, mx_cell_noise_float(vec3(x.mul(55), z.mul(55), 5.6).floor())) as any;
    const freckle = max(smoothstep(0.32, 0.08, f1).mul(f1Pick), smoothstep(0.3, 0.06, f2).mul(f2Pick)) as any;
    const toastCore = max(smoothstep(0.14, 0.02, f1).mul(f1Pick), smoothstep(0.12, 0.02, f2).mul(f2Pick)) as any;
    const toast = mix(vec3(0.72, 0.42, 0.16), vec3(0.45, 0.22, 0.07), toastCore) as any;
    c = mix(c, toast, freckle.mul(region).mul(peak.mul(0.7).add(0.3)));
    // Dense dark spice and herb specks all over: small, dark brown to near black, a few greenish.
    const herb = mx_worley_noise_float(vec3(x.mul(130), z.mul(130), 8.8)) as any;
    const herbPick = mx_cell_noise_float(vec3(x.mul(130), z.mul(130), 8.8).floor()) as any;
    const fleck = smoothstep(0.13, 0.05, herb).mul(step(0.42, herbPick)) as any;
    const fleckColour = mix(mix(vec3(0.24, 0.13, 0.05), vec3(0.06, 0.04, 0.03), step(0.7, herbPick)), vec3(0.17, 0.19, 0.07), step(0.93, herbPick)) as any;
    c = mix(c, fleckColour, fleck.mul(0.9));
    // Pits and crevices in shade: darker and browner.
    const cavity = clamp(h.negate().mul(1.1), 0, 1) as any;
    c = c.mul(float(1).sub(cavity.mul(0.4))).mul(vec3(1, 0.94, 0.86).mul(cavity).add(float(1).sub(cavity)));
    // A buttery baked sheen on the smooth raised parts; drier in the pits and on the toasted spots.
    const butter = smoothstep(0.35, 0.75, mx_noise_float(p.mul(9).add(13))) as any;
    const rough = float(0.62).sub(butter.mul(peak).mul(0.18)).add(cavity.mul(0.25)).add(freckle.mul(0.1)) as any;
    return vec4(c, rough);
  })() as any;

  const quad = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(quad);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const crust: Crust = {
    colour: colourTarget.texture,
    surface: surfaceTarget.texture,
    baked: false,
    passes: 0,
    checking: false,
    // Baked, then checked by reading one texel back; tried again (a few frames apart) until it took. A new pipeline is
    // built asynchronously, so its first draws can be skipped while it compiles (for longer on a phone) and leave the
    // target empty; and the bake is heavy (8M texels of noise), so it must not simply run every frame.
    bake(renderer) {
      if (crust.baked || crust.checking) return;
      const before = renderer.getRenderTarget();
      mesh.material = surfaceMaterial;
      renderer.setRenderTarget(surfaceTarget);
      renderer.render(scene, camera);
      mesh.material = colourMaterial;
      renderer.setRenderTarget(colourTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(before);
      crust.passes++;
      crust.checking = true;
      const check = (renderer as unknown as { readRenderTargetPixelsAsync: (t: THREE.RenderTarget, x: number, y: number, w: number, h: number) => Promise<ArrayLike<number>> })
        .readRenderTargetPixelsAsync;
      // Off the middle: there every noise sits on a lattice point and the slopes are exactly zero.
      const sx = Math.round(width * 0.37);
      const sy = Math.round(tall * 0.61);
      Promise.all([check.call(renderer, colourTarget, sx, sy, 1, 1), check.call(renderer, surfaceTarget, sx, sy, 1, 1)])
        .then(([colour, surface]) => {
          if (process.env.NODE_ENV !== "production") Object.assign(crust, { last: [Array.from(colour), Array.from(surface)] });
          // Drawn, the colour is pale dough and the slopes are never all zero; a target that was only cleared reads
          // black (its alpha is 1 either way, so alpha proves nothing).
          crust.baked = colour[0] > 0 && colour[1] > 0 && (surface[1] !== 0 || surface[2] !== 0);
        })
        .catch(() => {
          // Could not read back: trust a few passes instead.
          crust.baked = crust.passes >= 6;
        })
        .finally(() => (crust.checking = false));
    },
    dispose() {
      colourTarget.dispose();
      surfaceTarget.dispose();
      surfaceMaterial.dispose();
      colourMaterial.dispose();
      quad.dispose();
    }
  };
  return crust;
}
