// The crisping sleeve's print, drawn once at load: white card, red ink in a loose hand-drawn style, every word our own
// (no brand). The canvas wraps the sleeve: across it is along the sleeve's length (its open end at the right, toward the
// bite), and down it is round the tube, the top face in the middle band (TOP_FROM to TOP_TO).

import * as THREE from "three/webgpu";

export const TOP_FROM = 0.339;
export const TOP_TO = 0.661;

const W = 1024;
const H = 2048;
const RED = "#cf2b2f";
const CARD = "#f3efe6";

export function sleevePrint() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  g.fillStyle = CARD;
  g.fillRect(0, 0, W, H);
  // A faint grain in the card.
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(120, 100, 80, ${Math.random() * 0.05})`;
    g.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random() * 2, 1);
  }

  const top = TOP_FROM * H;
  const band = (TOP_TO - TOP_FROM) * H;
  const font = (size: number, weight = 900) => `${weight} ${size}px "Arial Black", "Helvetica Neue", Impact, sans-serif`;
  const text = (s: string, x: number, y: number, size: number, turn = 0, options: { fill?: string; stroke?: number; align?: CanvasTextAlign } = {}) => {
    g.save();
    g.translate(x, y);
    g.rotate(turn);
    g.font = font(size);
    g.textAlign = options.align ?? "center";
    g.textBaseline = "middle";
    if (options.stroke) {
      g.lineWidth = options.stroke;
      g.strokeStyle = RED;
      g.lineJoin = "round";
      g.strokeText(s, 0, 0);
      g.fillStyle = options.fill ?? CARD;
      g.fillText(s, 0, 0);
    } else {
      g.fillStyle = options.fill ?? RED;
      g.fillText(s, 0, 0);
    }
    g.restore();
  };

  // The top face. Its middle runs along y = top + band / 2; up the canvas is toward the pocket's -z side.
  const mid = top + band / 2;
  // The big banner: a red rounded ribbon with the name in card-white letters, a little askew.
  g.save();
  g.translate(W * 0.47, mid + band * 0.16);
  g.rotate(-0.035);
  g.fillStyle = RED;
  const bw = W * 0.86;
  const bh = band * 0.25;
  g.beginPath();
  g.roundRect(-bw / 2, -bh / 2, bw, bh, bh / 2);
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = CARD;
  g.beginPath();
  g.roundRect(-bw / 2 + 14, -bh / 2 + 14, bw - 28, bh - 28, bh / 2 - 14);
  g.stroke();
  g.restore();
  text("MOLTEN CORE", W * 0.47, mid + band * 0.16, band * 0.15, -0.035, { fill: CARD });

  text("CAUTION: CONTENTS", W * 0.3, top + band * 0.1, band * 0.052, 0.02);
  text("ARE MAGMA", W * 0.3, top + band * 0.17, band * 0.052, 0.02);
  // A little flame doodle in a ring.
  g.save();
  g.translate(W * 0.62, top + band * 0.15);
  g.strokeStyle = RED;
  g.lineWidth = 7;
  g.beginPath();
  g.arc(0, 0, band * 0.07, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(0, band * 0.045);
  g.bezierCurveTo(-band * 0.05, band * 0.02, -band * 0.02, -band * 0.02, 0, -band * 0.05);
  g.bezierCurveTo(band * 0.01, -band * 0.01, band * 0.05, band * 0.01, 0, band * 0.045);
  g.stroke();
  g.restore();
  text("WAIT 2 MINUTES…", W * 0.83, top + band * 0.1, band * 0.042, -0.05);
  text("OR DON'T", W * 0.83, top + band * 0.155, band * 0.042, -0.05);
  // Heat squiggles round it.
  g.strokeStyle = RED;
  g.lineWidth = 5;
  for (const [x, y] of [
    [W * 0.7, top + band * 0.12],
    [W * 0.96, top + band * 0.13]
  ]) {
    g.beginPath();
    for (let k = 0; k < 3; k++) g.arc(x, y, 14 + k * 12, -1.2, 1.2);
    g.stroke();
  }
  text("CRISPY!", W * 0.25, top + band * 0.38, band * 0.075, -0.12, { stroke: 10 });
  text("AND", W * 0.47, top + band * 0.36, band * 0.035, 0.05);
  text("GOOEY", W * 0.66, top + band * 0.4, band * 0.085, 0.06, { stroke: 10 });
  // The "DING!" burst near the open end.
  g.save();
  g.translate(W * 0.88, top + band * 0.42);
  g.strokeStyle = RED;
  g.lineWidth = 6;
  g.beginPath();
  for (let k = 0; k <= 18; k++) {
    const a = (k / 18) * Math.PI * 2;
    const r = k % 2 ? band * 0.06 : band * 0.09;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.stroke();
  g.restore();
  text("DING!", W * 0.88, top + band * 0.42, band * 0.04, -0.2);
  text("▲ INSERT POCKET HERE ▲", W * 0.5, top + band * 0.9, band * 0.04, 0, {});
  text("THIS SIDE UP", W * 0.5, top + band * 0.955, band * 0.028);

  // The sides and underneath: small repeated warnings and a fold mark.
  for (let row = 0; row < 7; row++) {
    const y = row < 3 ? top * (0.2 + row * 0.27) : top + band + (H - top - band) * (0.15 + (row - 3) * 0.24);
    text(row % 2 ? "CAUTION: FILLING MAY BE VOLCANIC" : "PULL ME! · HOLD BY SLEEVE · DO NOT LICK", W * 0.5, y, 30, 0, {});
  }
  text("PULL", W * 0.95, top - 70, 26, -Math.PI / 2);
  // The fold lines along the top's edges, pressed in the card.
  g.strokeStyle = "rgba(90, 70, 50, 0.18)";
  g.lineWidth = 3;
  for (const y of [top, top + band]) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
