// The props' printing, drawn once at load to canvases, every word our own (no brand, no real paper's masthead): the
// newspaper's front page, the empty MOLTEN CORE box in the sleeve's red-on-card style, and the meat thermometer's dial.

import * as THREE from "three/webgpu";
import { lehmer } from "../../shared/engine/random";

const RED = "#cf2b2f";
const INK = "#1d1b19";

function canvasTexture(canvas: HTMLCanvasElement) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function sheet(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, g: canvas.getContext("2d")! };
}

// ---------------------------------------------------------------------------------------------------------------
// The newspaper: the top half of a broadsheet's front page (above the fold), about 30 × 29 cm. Newsprint off-white
// yellowing toward its edges; a blackletter-ish masthead, a headline about the pocket, a halftone photo of an eruption,
// and columns of small grey type.

export const PAGE = { w: 2048, h: 1950 };

export function newspaperPrint() {
  const { canvas, g } = sheet(PAGE.w, 2048);
  const W = PAGE.w;
  const H = PAGE.h;
  const random = lehmer(2311);
  g.fillStyle = "#ebe5d4";
  g.fillRect(0, 0, W, 2048);
  // Yellowing: warmer and darker toward the edges, in soft blotches.
  const edge = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.78);
  edge.addColorStop(0, "rgba(220, 190, 120, 0)");
  edge.addColorStop(1, "rgba(200, 165, 95, 0.32)");
  g.fillStyle = edge;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) {
    const x = random() * W;
    const y = random() * H;
    const r = 60 + random() * 260;
    const blot = g.createRadialGradient(x, y, 0, x, y, r);
    blot.addColorStop(0, `rgba(205, 175, 110, ${0.05 + random() * 0.07})`);
    blot.addColorStop(1, "rgba(205, 175, 110, 0)");
    g.fillStyle = blot;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Fibres in the newsprint.
  for (let i = 0; i < 26000; i++) {
    g.fillStyle = `rgba(90, 80, 60, ${random() * 0.06})`;
    g.fillRect(random() * W, random() * H, 1 + random() * 3, 1);
  }

  const M = 90;
  g.fillStyle = INK;
  g.textBaseline = "alphabetic";
  // The masthead, between rules.
  g.font = `700 200px "Old English Text MT", "UnifrakturMaguntia", "Times New Roman", Georgia, serif`;
  g.textAlign = "center";
  g.fillText("The Daily Crust", W / 2, M + 190);
  g.fillRect(M, M + 230, W - 2 * M, 6);
  g.fillRect(M, M + 242, W - 2 * M, 2);
  g.font = `600 30px Georgia, "Times New Roman", serif`;
  g.textAlign = "left";
  g.fillText("VOL. CXLII · No. 23", M, M + 284);
  g.textAlign = "center";
  g.fillText("MONDAY, NOVEMBER 23, 2026  ·  LATE CITY EDITION  ·  WEATHER: 72°, LOCALLY 2,100°", W / 2, M + 284);
  g.textAlign = "right";
  g.fillText("$1.50", W - M, M + 284);
  g.fillRect(M, M + 302, W - 2 * M, 2);
  g.fillRect(M, M + 310, W - 2 * M, 6);

  // The headline, condensed, across the full width.
  const condensed = (s: string, x: number, y: number, size: number, width: number, weight = 900, family = `"Helvetica Neue", Helvetica, Arial, sans-serif`) => {
    g.font = `${weight} ${size}px ${family}`;
    const natural = g.measureText(s).width;
    g.save();
    g.translate(x, y);
    g.scale(Math.min(1, width / natural), 1);
    g.textAlign = "center";
    g.fillText(s, 0, 0);
    g.restore();
  };
  g.fillStyle = INK;
  condensed("LOCAL MAN BITES TOO SOON", W / 2, M + 520, 210, W - 2 * M - 10);
  g.font = `italic 400 64px Georgia, "Times New Roman", serif`;
  g.textAlign = "center";
  g.fillText("Scientists baffled: center still frozen, edges 900°F", W / 2, M + 610);
  g.fillRect(M, M + 650, W - 2 * M, 3);

  // Columns of body type: real-looking words of random letters, set justified-ish in eight columns.
  const letters = "etaoinshrdlucmfwypvbgk";
  const word = () => {
    let s = "";
    const n = 1 + Math.floor(random() * 8);
    for (let k = 0; k < n; k++) s += letters[Math.floor(Math.pow(random(), 1.6) * letters.length)];
    return s;
  };
  const column = (x: number, y0: number, w: number, y1: number, size = 22, lead = 27, startCap = false) => {
    g.font = `400 ${size}px Georgia, "Times New Roman", serif`;
    g.fillStyle = "#2a2724";
    g.textAlign = "left";
    let y = y0;
    let first = startCap;
    while (y < y1) {
      let line = "";
      while (g.measureText(line + " " + word()).width < w - size) line += (line ? " " : "") + word();
      if (first) line = line[0].toUpperCase() + line.slice(1);
      first = false;
      // Short last lines of paragraphs, now and then.
      if (random() < 0.08) {
        g.fillText(line.slice(0, Math.floor(line.length * (0.3 + random() * 0.5))), x + (first ? size : 0), y);
        y += lead;
        first = true;
        continue;
      }
      g.fillText(line, x, y);
      y += lead;
    }
  };
  const halftone = (x: number, y: number, w: number, h: number, shade: (u: number, v: number) => number, step = 9) => {
    g.fillStyle = "#d8d1bf";
    g.fillRect(x, y, w, h);
    g.fillStyle = "#1f1c1a";
    for (let j = 0; j < h; j += step)
      for (let i = (j / step) % 2 ? step / 2 : 0; i < w; i += step) {
        const d = shade(i / w, j / h);
        if (d < 0.03) continue;
        g.beginPath();
        g.arc(x + i, y + j, (step / 1.7) * Math.sqrt(d), 0, Math.PI * 2);
        g.fill();
      }
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.strokeRect(x, y, w, h);
  };

  const top = M + 690;
  const gutter = 34;
  const cols = 6;
  const colW = (W - 2 * M - gutter * (cols - 1)) / cols;
  const colX = (k: number) => M + k * (colW + gutter);
  // The lead photo across four columns: a volcano erupting, as a halftone. Ink density from a drawn picture: sky, a cone,
  // a plume, and the lava's bright tongues reading as paper-white.
  const photoW = colW * 4 + gutter * 3;
  const photoH = 640;
  halftone(colX(0), top, photoW, photoH, (u, v) => {
    const skyline = 0.42 + Math.abs(u - 0.52) * 0.95;
    const cone = v > skyline ? 1 : 0;
    const plume = Math.max(0, 1 - Math.hypot((u - 0.52 - (0.3 - v) * 0.25) * 2.4, (v - 0.22) * 2.2)) * (v < 0.46 ? 1 : 0);
    const tongue = Math.max(0, 1 - Math.abs(u - 0.5 - Math.sin(v * 9) * 0.04) * 22) * (v > 0.42 ? 1 : 0) + Math.max(0, 1 - Math.abs(u - 0.62 - (v - 0.5) * 0.4) * 30) * (v > 0.5 ? 1 : 0);
    const sky = 0.22 + v * 0.25;
    return Math.min(1, Math.max(0, (cone ? 0.82 - tongue * 0.9 : sky + plume * 0.65) + Math.sin(u * 60) * Math.sin(v * 50) * 0.04));
  });
  g.font = `italic 400 24px Georgia, "Times New Roman", serif`;
  g.fillStyle = "#2a2724";
  g.textAlign = "left";
  g.fillText("The scene on a paper plate in a downtown kitchen, moments after the first bite. “I heard it ding,” said a witness.", colX(0), top + photoH + 36);
  for (let k = 0; k < 4; k++) column(colX(k), top + photoH + 84, colW, H - M, 22, 27, k === 0);
  // The side stories in the two right columns.
  const side = (x: number, y: number, head: string[], deck: string, to: number) => {
    g.fillStyle = INK;
    g.textAlign = "left";
    let yy = y;
    for (const line of head) {
      condensed(line, x + colW / 2, yy + 52, 58, colW, 800);
      yy += 60;
    }
    g.font = `italic 400 28px Georgia, "Times New Roman", serif`;
    g.textAlign = "left";
    g.fillStyle = "#2a2724";
    g.fillText(deck, x, yy + 22);
    column(x, yy + 64, colW, to, 22, 27, true);
  };
  side(colX(4), top, ["MICROWAVE", "DINGS;", "BLOCK", "EVACUATED"], "Residents told to wait", top + 560);
  g.fillRect(colX(4), top + 586, colW, 2);
  side(colX(4), top + 610, ["OPINION:", "JUST WAIT", "TWO MINUTES"], "Our editors plead again", H - M);
  side(colX(5), top, ["SLEEVE", "‘DID ITS", "BEST,’ SAYS", "EXPERT"], "Card reached 600°", top + 760);
  g.fillRect(colX(5), top + 786, colW, 2);
  // A small mugshot halftone in the last column.
  halftone(colX(5), top + 810, colW, 260, (u, v) => {
    const head = Math.hypot((u - 0.5) * 1.6, (v - 0.42) * 1.2) < 0.32 ? 0.5 : 0.25;
    const body = v > 0.72 && Math.abs(u - 0.5) < 0.38 ? 0.75 : 0;
    return Math.max(head, body);
  });
  g.font = `italic 400 20px Georgia, "Times New Roman", serif`;
  g.fillStyle = "#2a2724";
  g.fillText("The man, before.", colX(5), top + 1100);
  column(colX(5), top + 1140, colW, H - M);
  // Column rules.
  g.fillStyle = "rgba(30, 27, 25, 0.5)";
  for (let k = 1; k < cols; k++) if (k !== 1 && k !== 2 && k !== 3) g.fillRect(colX(k) - gutter / 2, top, 1.5, H - M - top);
  for (let k = 1; k < 4; k++) g.fillRect(colX(k) - gutter / 2, top + photoH + 60, 1.5, H - M - top - photoH - 60);

  // A ring where a mug stood, faint.
  g.strokeStyle = "rgba(150, 105, 50, 0.16)";
  for (let k = 0; k < 3; k++) {
    g.lineWidth = 6 + k * 5;
    g.beginPath();
    g.arc(W * 0.83 + k * 3, H * 0.83, 150 - k * 2, 0.2 + k, Math.PI * 1.8 + k * 0.5);
    g.stroke();
  }

  // The page's edges: the rows below the page (2048 - PAGE.h) hold plain newsprint for the stack's sides.
  g.fillStyle = "#e3dccb";
  g.fillRect(0, H, W, 2048 - H);
  return canvasTexture(canvas);
}

// ---------------------------------------------------------------------------------------------------------------
// The thermometer's dial: 0 to 220 °F round three-quarters of the face, a red zone past 200 marked LAVA, and the needle
// bent hard against the stop pin beyond it.

export function dialPrint() {
  const S = 1024;
  const { canvas, g } = sheet(S, S);
  const c = S / 2;
  g.fillStyle = "#f4f1ea";
  g.fillRect(0, 0, S, S);
  const shade = g.createRadialGradient(c, c, S * 0.2, c, c, S * 0.5);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(60,50,40,0.18)");
  g.fillStyle = shade;
  g.fillRect(0, 0, S, S);
  const from = Math.PI * 0.75;
  const span = Math.PI * 1.5;
  const at = (t: number) => from + t * span;
  // The red zone.
  g.strokeStyle = RED;
  g.lineWidth = 60;
  g.beginPath();
  g.arc(c, c, S * 0.39, at(200 / 220), at(1));
  g.stroke();
  g.strokeStyle = "#e8a23a";
  g.beginPath();
  g.arc(c, c, S * 0.39, at(165 / 220), at(200 / 220));
  g.stroke();
  // Ticks and numbers.
  g.strokeStyle = INK;
  g.fillStyle = INK;
  for (let v = 0; v <= 220; v += 5) {
    const a = at(v / 220);
    const major = v % 20 === 0;
    g.lineWidth = major ? 7 : 3;
    g.beginPath();
    g.moveTo(c + Math.cos(a) * S * (major ? 0.33 : 0.36), c + Math.sin(a) * S * (major ? 0.33 : 0.36));
    g.lineTo(c + Math.cos(a) * S * 0.42, c + Math.sin(a) * S * 0.42);
    g.stroke();
    if (major) {
      g.font = `800 54px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(v), c + Math.cos(a) * S * 0.27, c + Math.sin(a) * S * 0.27);
    }
  }
  g.font = `900 64px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
  g.fillStyle = RED;
  g.textAlign = "center";
  g.fillText("LAVA", c + Math.cos(at(1.03)) * S * 0.3, c + Math.sin(at(1.03)) * S * 0.3 + 40);
  g.fillStyle = INK;
  g.font = `700 46px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  g.fillText("°F", c, c + S * 0.2);
  g.font = `800 34px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  g.fillText("RARE · MED · WELL · ERUPTED", c, c + S * 0.29);
  // The stop pin, and the needle jammed past it.
  const stop = at(1.06);
  g.fillStyle = "#555";
  g.beginPath();
  g.arc(c + Math.cos(stop) * S * 0.4, c + Math.sin(stop) * S * 0.4, 14, 0, Math.PI * 2);
  g.fill();
  const needle = at(1.04);
  g.save();
  g.translate(c, c);
  g.rotate(needle);
  g.shadowColor = "rgba(0,0,0,0.35)";
  g.shadowBlur = 14;
  g.shadowOffsetX = 8;
  g.shadowOffsetY = 10;
  g.fillStyle = RED;
  g.beginPath();
  g.moveTo(-S * 0.08, -12);
  g.lineTo(S * 0.4, -3);
  g.lineTo(S * 0.4, 3);
  g.lineTo(-S * 0.08, 12);
  g.closePath();
  g.fill();
  g.restore();
  g.fillStyle = "#333";
  g.beginPath();
  g.arc(c, c, 34, 0, Math.PI * 2);
  g.fill();
  return canvasTexture(canvas);
}
