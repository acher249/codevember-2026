import * as THREE from "three/webgpu";
import { attribute, float, texture, uv, vec2, vec3 } from "three/tsl";

// The shops' names, lettered once into a strip of rows on a canvas, one row a shop; each sign's lettering is a quad
// in front of its board reading its own row (its tint's red picks the row), gilt where the canvas is lettered.

export const SHOP_NAMES = ["DELI & GROCERY", "LAUNDROMAT", "PIZZA", "HARDWARE", "CAFE", "DRY CLEANERS", "WINE & LIQUORS", "NAILS"];
const ROW = { width: 1024, height: 112 };

// The row's middle as the tint's red, for a sign showing the name at k.
export const nameTint = (k: number) => new THREE.Color((k % SHOP_NAMES.length) + 0.5, 0, 0);

export function signLettering() {
  // (Built in the browser only: there is no canvas to letter on elsewhere.)
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = ROW.width;
  canvas.height = ROW.height * SHOP_NAMES.length;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  SHOP_NAMES.forEach((name, k) => {
    // As large as fits the row, in a heavy serif as gilt shop lettering is.
    let size = ROW.height * 0.72;
    ctx.font = `700 ${size}px Georgia, "Times New Roman", serif`;
    const fit = (ROW.width * 0.92) / ctx.measureText(name).width;
    if (fit < 1) size *= fit;
    ctx.font = `700 ${size}px Georgia, "Times New Roman", serif`;
    ctx.fillText(name, ROW.width / 2, ROW.height * (k + 0.53));
  });
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.NoColorSpace;
  map.anisotropy = 8;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.6, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const at = uv();
  const row = attribute("tint", "vec3").x.sub(0.5);
  // The canvas's rows run down from its top; its uv's v runs up.
  const ink = texture(map, vec2(at.x, float(1).sub(row.add(float(1).sub(at.y)).div(SHOP_NAMES.length)))).r;
  material.colorNode = vec3(0.78, 0.63, 0.32);
  material.opacityNode = ink;
  material.addEventListener("dispose", () => map.dispose());
  return material;
}
