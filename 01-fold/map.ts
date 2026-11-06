import * as THREE from "three/webgpu";
import { lehmer, pointHash } from "../shared/engine/random";

// The land is one long sheet. u runs across the folds, v along them, in world units.
export const PANELS = 8;
export const PANEL_WIDTH = 1.7;
export const PANEL_DEPTH = 7.2;
export const SHEET_WIDTH = PANELS * PANEL_WIDTH;

function valueNoise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = pointHash(ix, iy) * (1 - sx) + pointHash(ix + 1, iy) * sx;
  const bottom = pointHash(ix, iy + 1) * (1 - sx) + pointHash(ix + 1, iy + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

export const riverAt = (u: number) => Math.sin(u * 0.62 + 1.1) * 1.25 + Math.sin(u * 1.7) * 0.34 - 0.3;
export const isRiver = (u: number, v: number) => Math.abs(v - riverAt(u)) < 0.26;

// Rolling ground on the flat sheet, sunk for the river. Each fold pinches it to nothing at its own creases.
export function hillsAt(u: number, v: number) {
  const edge = Math.min(1, (PANEL_DEPTH / 2 - Math.abs(v)) * 2.5);
  const hills = valueNoise(u * 0.8 + 3, v * 0.8) * 0.3 + valueNoise(u * 2.3, v * 2.3 + 9) * 0.07;
  const bank = Math.max(0, Math.min(1, (Math.abs(v - riverAt(u)) - 0.2) / 0.28));
  return Math.max(0, hills * Math.max(0, edge) * bank * bank);
}

const FIELDS = ["#6f9a3e", "#88ad45", "#5d8c3a", "#a7b54a", "#d6b24e", "#c79a3f", "#74a04a", "#7d7ac0", "#54823c"];

// Land drawn as a hand-coloured survey map: the grass grows out of it and takes its colour from it.
export function paintLand() {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = Math.round((2048 * PANEL_DEPTH) / SHEET_WIDTH);
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  const sx = canvas.width / SHEET_WIDTH;
  const sy = canvas.height / PANEL_DEPTH;
  const x = (u: number) => u * sx;
  const y = (v: number) => (v + PANEL_DEPTH / 2) * sy;
  const rand = lehmer(40718);

  g.fillStyle = "#6f9a3e";
  g.fillRect(0, 0, canvas.width, canvas.height);

  // Patchwork fields, on a wobbling grid so nothing lines up with a fold.
  const columns = 15;
  const rows = 8;
  const corner = (c: number, r: number) => {
    const jx = (pointHash(c, r) - 0.5) * 0.5;
    const jy = (pointHash(r + 40, c) - 0.5) * 0.45;
    return [((c + jx) / columns) * SHEET_WIDTH, ((r + jy) / rows) * PANEL_DEPTH - PANEL_DEPTH / 2];
  };
  for (let c = -1; c <= columns; c++) {
    for (let r = -1; r <= rows; r++) {
      const quad = [corner(c, r), corner(c + 1, r), corner(c + 1, r + 1), corner(c, r + 1)];
      const fill = FIELDS[Math.floor(rand() * FIELDS.length)];
      g.beginPath();
      quad.forEach(([u, v], i) => (i ? g.lineTo(x(u), y(v)) : g.moveTo(x(u), y(v))));
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      // Plough lines, in the field's own colour.
      g.save();
      g.clip();
      g.globalAlpha = 0.16;
      g.strokeStyle = "#1e2a12";
      g.lineWidth = 1;
      const tilt = rand() * Math.PI;
      const cx = x(quad[0][0]);
      const cy = y(quad[0][1]);
      for (let k = -24; k < 24; k++) {
        g.beginPath();
        g.moveTo(cx + Math.cos(tilt) * 260 + Math.sin(tilt) * k * 7, cy + Math.sin(tilt) * 260 - Math.cos(tilt) * k * 7);
        g.lineTo(cx - Math.cos(tilt) * 260 + Math.sin(tilt) * k * 7, cy - Math.sin(tilt) * 260 - Math.cos(tilt) * k * 7);
        g.stroke();
      }
      g.restore();
      // Hedges.
      g.globalAlpha = 0.85;
      g.strokeStyle = "#2f4a22";
      g.lineWidth = 3;
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  // A lane that wanders the length of the sheet.
  g.strokeStyle = "#e4d3a6";
  g.lineCap = "round";
  g.lineWidth = 7;
  g.beginPath();
  for (let u = 0; u <= SHEET_WIDTH; u += 0.1) {
    const v = riverAt(u) + 1.7 + Math.sin(u * 1.1) * 0.5;
    if (u === 0) g.moveTo(x(u), y(v));
    else g.lineTo(x(u), y(v));
  }
  g.stroke();

  // The river, with a pale bank under it.
  for (const [width, colour] of [
    [0.62, "#c9c196"],
    [0.46, "#3d8db8"],
    [0.26, "#5fb4d6"]
  ] as const) {
    g.strokeStyle = colour;
    g.lineWidth = width * sy;
    g.beginPath();
    for (let u = -0.1; u <= SHEET_WIDTH + 0.1; u += 0.05) {
      if (u <= -0.1) g.moveTo(x(u), y(riverAt(u)));
      else g.lineTo(x(u), y(riverAt(u)));
    }
    g.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

// The back of the sheet: cream paper, contour lines, and the map's own marginalia.
export function paintBack() {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = Math.round((2048 * PANEL_DEPTH) / SHEET_WIDTH);
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#efe6d2";
  g.fillRect(0, 0, canvas.width, canvas.height);

  const rand = lehmer(991);
  g.strokeStyle = "rgba(122, 86, 54, 0.42)";
  g.lineWidth = 1.4;
  for (let hill = 0; hill < 13; hill++) {
    const cx = rand() * canvas.width;
    const cy = rand() * canvas.height;
    const seed = rand() * 90;
    for (let ring = 1; ring < 9; ring++) {
      g.beginPath();
      for (let k = 0; k <= 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        const r = ring * 17 * (1 + (valueNoise(Math.cos(a) * 1.6 + seed, Math.sin(a) * 1.6 + ring * 0.1) - 0.5) * 0.7);
        const px = cx + Math.cos(a) * r * 1.3;
        const py = cy + Math.sin(a) * r;
        if (k) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.stroke();
    }
  }

  g.strokeStyle = "rgba(44, 76, 110, 0.22)";
  g.lineWidth = 1;
  for (let k = 1; k < 16; k++) {
    g.beginPath();
    g.moveTo((k / 16) * canvas.width, 0);
    g.lineTo((k / 16) * canvas.width, canvas.height);
    g.stroke();
  }
  for (let k = 1; k < 9; k++) {
    g.beginPath();
    g.moveTo(0, (k / 9) * canvas.height);
    g.lineTo(canvas.width, (k / 9) * canvas.height);
    g.stroke();
  }

  // Printed twice, head to head as on a real map, so one of them reads upright from either side.
  g.fillStyle = "rgba(58, 40, 26, 0.82)";
  g.textAlign = "center";
  for (const turn of [0, Math.PI]) {
    g.save();
    g.translate(canvas.width * 0.5, canvas.height * 0.5);
    g.rotate(turn);
    g.font = "italic 92px Georgia, serif";
    g.fillText("The Folded Country", 0, canvas.height * 0.24);
    g.font = "28px Georgia, serif";
    g.fillText("Sheet 1. Do not refold along the river.", 0, canvas.height * 0.24 + 52);
    g.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
