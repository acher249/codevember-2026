import * as THREE from "three/webgpu";
import { lehmer } from "../../shared/engine/random";

// Feathers drawn once at load into a two-cell atlas, in grey to be tinted per feather: on the left a body (contour)
// feather, broad and rounded with a fluffy base; on the right a flight feather, long, stiff and asymmetric. Each is a
// rachis with barbs swept toward the tip, a few splits in the vane where barbs have come unzipped, and soft down at the
// root. Root at the bottom, tip at the top.

export function featherAtlas() {
  const W = 1024;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, W, H);
  const random = lehmer(4471);

  const draw = (x0: number, cellW: number, half: (t: number) => [number, number], fluff: number, barbs: number, angle: number) => {
    const cx = x0 + cellW / 2;
    const top = 12;
    const bottom = H - 12;
    const yAt = (t: number) => bottom - t * (bottom - top);
    // The vane, filled, as the alpha.
    g.save();
    g.beginPath();
    for (let i = 0; i <= 80; i++) {
      const t = i / 80;
      g.lineTo(cx - half(t)[0], yAt(t));
    }
    for (let i = 80; i >= 0; i--) {
      const t = i / 80;
      g.lineTo(cx + half(t)[1], yAt(t));
    }
    g.closePath();
    g.fillStyle = "rgb(150,150,150)";
    g.fill();
    g.clip();
    // Barbs: fine lines from the rachis out toward the tip, each its own shade.
    for (let i = 0; i < barbs; i++) {
      const t = i / barbs;
      for (const s of [-1, 1]) {
        const reach = half(Math.min(1, t + 0.05))[s < 0 ? 0 : 1];
        const shade = 110 + random() * 90 + (s > 0 ? 10 : 0);
        g.strokeStyle = `rgba(${shade},${shade},${shade},0.85)`;
        g.lineWidth = 1 + random() * 1.4;
        g.beginPath();
        g.moveTo(cx, yAt(t));
        g.quadraticCurveTo(cx + s * reach * 0.5, yAt(t) - reach * angle * 0.4, cx + s * reach * 1.05, yAt(t) - reach * angle);
        g.stroke();
      }
    }
    // Light catching the barb tips along the edge, and a darker band beside the rachis.
    g.restore();
    // Splits: thin wedges cut from the vane, along the barbs.
    g.save();
    g.globalCompositeOperation = "destination-out";
    for (let k = 0; k < 4; k++) {
      const t = 0.3 + random() * 0.6;
      const s = random() < 0.5 ? -1 : 1;
      const reach = half(t)[s < 0 ? 0 : 1];
      g.strokeStyle = "rgba(0,0,0,1)";
      g.lineWidth = 2 + random() * 3;
      g.beginPath();
      g.moveTo(cx + s * reach * (0.35 + random() * 0.3), yAt(t) - reach * angle * 0.3);
      g.lineTo(cx + s * reach * 1.1, yAt(t) - reach * angle * 1.05);
      g.stroke();
    }
    g.restore();
    // Down at the root: loose curling barbs, half see-through.
    for (let i = 0; i < 160 * fluff; i++) {
      const t = random() * 0.22;
      const s = random() < 0.5 ? -1 : 1;
      const reach = (half(t)[s < 0 ? 0 : 1] + 10) * (0.8 + random() * 0.6);
      const shade = 170 + random() * 60;
      g.strokeStyle = `rgba(${shade},${shade},${shade},${0.25 + random() * 0.35})`;
      g.lineWidth = 1 + random();
      g.beginPath();
      g.moveTo(cx, yAt(t));
      g.bezierCurveTo(cx + s * reach * 0.4, yAt(t) - 10 + random() * 20, cx + s * reach * 0.8, yAt(t) + random() * 30 - 15, cx + s * reach, yAt(t) - random() * 40);
      g.stroke();
    }
    // The rachis: a pale shaft, thick at the root and fine at the tip.
    g.strokeStyle = "rgba(225,220,210,1)";
    for (let i = 0; i < 40; i++) {
      const t0 = i / 40;
      const t1 = (i + 1) / 40;
      g.lineWidth = 7 * (1 - t0) + 1;
      g.beginPath();
      g.moveTo(cx, yAt(t0));
      g.lineTo(cx, yAt(t1));
      g.stroke();
    }
  };

  // Contour: an oval vane, widest two thirds up, rounded at the tip.
  draw(
    0,
    W / 2,
    (t) => {
      const w = Math.sin(Math.min(1, t * 1.05) * Math.PI * 0.92 + 0.1) * (0.55 + 0.45 * Math.min(1, t * 2));
      const r = Math.max(0, w) * 200;
      return [r, r * 0.96];
    },
    1,
    130,
    0.55
  );
  // Flight: long and narrow, the leading vane slim and the trailing vane broad, tapering to a rounded point.
  draw(
    W / 2,
    W / 2,
    (t) => {
      const body = Math.min(1, t * 6) * Math.pow(Math.max(0, 1 - Math.pow(t, 3)), 0.5);
      return [body * 70, body * 175];
    },
    0.35,
    220,
    0.35
  );
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
