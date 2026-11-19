import type { Node } from "three/webgpu";
import { Fn, If, cos, float, int, sin, sRGBTransferEOTF, vec3 } from "three/tsl";
import { ZUV_ARTISTIC } from "./zuv";

// Call after varying the signed ZUV coordinates, so interpolation between
// columns follows the same mixing space as the paint simulation.
const inverseDelta = (zuv: Node<"vec3">) => {
  const { tau, zRed, p2, p3 } = ZUV_ARTISTIC;
  const angle = zuv.x.sub(zRed).mul(-tau);
  const c = cos(angle), s = sin(angle);
  const beta = c.mul(zuv.y).sub(s.mul(zuv.z));
  const gamma = s.mul(zuv.y).add(c.mul(zuv.z));
  return vec3(...p2).mul(beta).add(vec3(...p3).mul(gamma));
};

/** Raw encoded RGB, including out-of-gamut values. */
export const zuvToRgbNode = Fn(([zuv]: [Node<"vec3">]) => inverseDelta(zuv).add(zuv.x));

/** Shorten one UV ray to the RGB cube; never alter the simulation buffers. */
export const zuvToDisplayRgbNode = Fn(([zuv]: [Node<"vec3">]) => {
  const z = zuv.x.clamp(0, 1).toVar();
  const delta = inverseDelta(vec3(z, zuv.yz)).toVar();
  // Guard both denominators: a shader may evaluate both branches of select.
  const bound = (channel: Node<"float">) => channel.greaterThan(0).select(
    float(1).sub(z).div(channel.max(1e-12)),
    channel.lessThan(0).select(z.div(channel.negate().max(1e-12)), float(1))
  );
  const scale = bound(delta.x).min(bound(delta.y)).min(bound(delta.z)).clamp(0, 1);
  return delta.mul(scale).add(z).clamp(0, 1);
});

/** Material-ready linear RGB; the encoded display colour is decoded once. */
export function zuvToLinearNode(zuv: Node<"vec3">): Node<"vec3"> {
  return sRGBTransferEOTF(zuvToDisplayRgbNode(zuv)) as Node<"vec3">;
}

/** Both histories run together; Original skips the ZUV decode when displayed. */
export const paintColourNode = Fn(([rgb, zuv, mixing]: [Node<"vec3">, Node<"vec3">, Node<"int">]) => {
  const colour = rgb.toVar();
  If(mixing.equal(int(1)), () => colour.assign(zuvToLinearNode(zuv)));
  return colour;
});
