// The shell's prints, drawn once at load, all our own: the name over the window, a tagline under it, the letters under
// the buttons; on the back a moulded name, the battery door's outline and screw, the reset hole and the small print. The
// back's relief goes in a second canvas, as height, for the bump.
//
// Each canvas maps the shell's front (or back) straight on: across is x from -PRINT.w / 2 to PRINT.w / 2 and down is y from
// PRINT.h / 2 to -PRINT.h / 2 (cm). The back is drawn as seen from behind, so it reads the right way round.

import * as THREE from "three/webgpu";
import { BATTERY, BUTTONS, PIN } from "./shape";

export const PRINT = { w: 5, h: 6 };
const PX = 220;
const W = PRINT.w * PX;
const H = PRINT.h * PX;
export const NAME = "nestbit";

const at = (x: number, y: number) => [W / 2 + x * PX, H / 2 - y * PX] as const;
const round = "\"Arial Rounded MT Bold\", \"Varela Round\", \"Nunito\", \"Helvetica Neue\", Arial, sans-serif";

function canvas() {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  return { c, g: c.getContext("2d")! };
}

function finish(c: HTMLCanvasElement, colour = true) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// White ink, as pad-printed on candy plastic: the name, a tagline, the button letters, a few sparkles.
export function frontPrint() {
  const { c, g } = canvas();
  const ink = "rgba(255, 250, 246, 0.96)";
  g.fillStyle = ink;
  g.strokeStyle = ink;
  g.textAlign = "center";
  g.textBaseline = "middle";
  // The name, bold and round, a little arched over the window.
  const name = NAME;
  const [nx, ny] = at(0, 2.06);
  g.font = `900 ${0.5 * PX}px ${round}`;
  const widths = [...name].map((ch) => g.measureText(ch).width * 0.94);
  const total = widths.reduce((s, w) => s + w, 0);
  let x = nx - total / 2;
  [...name].forEach((ch, i) => {
    const mid = x + widths[i] / 2;
    const lean = (mid - nx) / total;
    g.save();
    g.translate(mid, ny + lean * lean * 0.5 * PX);
    g.rotate(lean * 0.35);
    g.fillText(ch, 0, 0);
    g.restore();
    x += widths[i];
  });
  // Sparkles either side of it.
  const star = (sx: number, sy: number, r: number) => {
    const [cx, cy] = at(sx, sy);
    g.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const rr = k % 2 ? r * 0.28 : r;
      g.lineTo(cx + Math.cos(a) * rr * PX, cy + Math.sin(a) * rr * PX);
    }
    g.closePath();
    g.fill();
  };
  star(-1.12, 2.32, 0.13);
  star(1.18, 2.36, 0.09);
  star(-1.02, 1.86, 0.06);
  // A tagline between the window and the buttons.
  g.font = `700 ${0.13 * PX}px ${round}`;
  const [tx, ty] = at(0, -0.97);
  g.fillText("V I R T U A L   N E S T   P A L", tx, ty);
  // The button letters, under each.
  g.font = `900 ${0.2 * PX}px ${round}`;
  for (const [k, b] of BUTTONS.entries()) {
    const [bx, by] = at(b.x, b.y - 0.66);
    g.fillText("ABC"[k], bx, by);
  }
  return finish(c);
}

// The back: ink (white, small) in one canvas; relief (grey 0.5 is flat, darker is pressed in) in another.
export function backPrint() {
  const ink = canvas();
  const relief = canvas();
  const h = relief.g;
  h.fillStyle = "rgb(128, 128, 128)";
  h.fillRect(0, 0, W, H);
  // Mirrored: seen from behind, +x on the shell is to the left.
  const back = (x: number, y: number) => at(-x, y);

  // The moulded name, pressed in, high on the back.
  const [mx, my] = back(0, 1.55);
  h.textAlign = "center";
  h.textBaseline = "middle";
  h.font = `900 ${0.56 * PX}px ${round}`;
  h.filter = "blur(2px)";
  h.fillStyle = "rgb(60, 60, 60)";
  h.fillText(NAME, mx, my);
  h.font = `700 ${0.13 * PX}px ${round}`;
  h.fillText("·  MODEL NB-97  ·", mx, my + 0.42 * PX);
  h.filter = "none";

  // The battery door: a fine groove round it, a finger notch, and a screw.
  const [dx, dy] = back(BATTERY.x, BATTERY.y);
  const rw = BATTERY.w * PX;
  const rh = BATTERY.h * PX;
  h.strokeStyle = "rgb(20, 20, 20)";
  h.lineWidth = 0.035 * PX;
  h.filter = "blur(1.5px)";
  h.beginPath();
  h.roundRect(dx - rw / 2, dy - rh / 2, rw, rh, 0.22 * PX);
  h.stroke();
  h.lineWidth = 0.02 * PX;
  for (let k = -2; k <= 2; k++) {
    h.beginPath();
    h.moveTo(dx - 0.3 * PX, dy + rh / 2 - 0.14 * PX + k * 0.045 * PX);
    h.lineTo(dx + 0.3 * PX, dy + rh / 2 - 0.14 * PX + k * 0.045 * PX);
    h.stroke();
  }
  const [sx, sy] = back(BATTERY.x, BATTERY.y + BATTERY.h / 2 - 0.25);
  h.fillStyle = "rgb(40, 40, 40)";
  h.beginPath();
  h.arc(sx, sy, 0.1 * PX, 0, Math.PI * 2);
  h.fill();
  h.strokeStyle = "rgb(150, 150, 150)";
  h.lineWidth = 0.025 * PX;
  h.beginPath();
  h.moveTo(sx - 0.06 * PX, sy);
  h.lineTo(sx + 0.06 * PX, sy);
  h.moveTo(sx, sy - 0.06 * PX);
  h.lineTo(sx, sy + 0.06 * PX);
  h.stroke();
  // The reset pinhole, deep.
  const [px, py] = back(PIN.x, PIN.y);
  h.fillStyle = "rgb(0, 0, 0)";
  h.beginPath();
  h.arc(px, py, 0.05 * PX, 0, Math.PI * 2);
  h.fill();
  h.strokeStyle = "rgb(70, 70, 70)";
  h.lineWidth = 0.02 * PX;
  h.beginPath();
  h.arc(px, py, 0.09 * PX, 0, Math.PI * 2);
  h.stroke();
  h.filter = "none";

  // Ink: the small print, the battery's size on the door, the reset label.
  const g = ink.g;
  g.fillStyle = "rgba(255, 250, 246, 0.85)";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${0.15 * PX}px ${round}`;
  g.fillText("CR2032  3V", dx, dy - 0.05 * PX);
  g.fillText("+", dx - 0.55 * PX, dy - 0.05 * PX);
  g.font = `700 ${0.1 * PX}px ${round}`;
  g.fillText("RESET", px, py + 0.2 * PX);
  g.fillText("NOT A FOOD. DO NOT FEED TO PETS.", mx, back(0, -2.05)[1]);
  g.fillText("MADE BY NOBODY IN PARTICULAR · 1997", mx, back(0, -2.22)[1]);
  return { ink: finish(ink.c), relief: finish(relief.c, false) };
}

// The tab: clear-white film with PULL in red and arrows pointing out.
export function tabPrint() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 1024;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4f1ec";
  g.fillRect(0, 0, 256, 1024);
  g.fillStyle = "#d8262f";
  g.save();
  g.translate(128, 330);
  g.rotate(Math.PI / 2);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `900 120px ${round}`;
  g.fillText("PULL", 0, 0);
  g.restore();
  // Arrows toward the free end (the canvas's top).
  for (let k = 0; k < 2; k++) {
    const y = 90 + k * 62;
    g.beginPath();
    g.moveTo(128, y - 34);
    g.lineTo(178, y + 12);
    g.lineTo(78, y + 12);
    g.closePath();
    g.fill();
  }
  g.fillStyle = "rgba(60, 50, 50, 0.5)";
  g.font = `700 34px ${round}`;
  g.save();
  g.translate(128, 650);
  g.rotate(Math.PI / 2);
  g.textAlign = "center";
  g.fillText("TO START", 0, 0);
  g.restore();
  return finish(c);
}
