import * as THREE from "three/webgpu";
import { SIGNS } from "./signs";

// The dial, projected onto the sky. Its rings are lines of latitude on the star sphere, read from inside: the months and seasons above the
// machine, and the zodiac below it. Everything stays at its true angle round the sky, so the months still line up with the Earth's arm.
export type Band = { elevation: number; span: number; height: number; radius: number };

// Lettering is laid out on an imaginary sphere of this size, which only sets how big it is against its band.
const LAYOUT_RADIUS = 12.3;
const band = (elevation: number, span: number): Band => ({
  elevation,
  span,
  height: LAYOUT_RADIUS * ((span * Math.PI) / 180),
  radius: LAYOUT_RADIUS * Math.cos((elevation * Math.PI) / 180)
});

export const SEASONS = band(5.2, 2.35);
export const ZODIAC = band(-25.5, 4);
export const MONTHS = band(2.5, 3.35);

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const FONT = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const TURN = Math.PI * 2;

// Where the Earth's arm points on a given day of the year. Its longitude at the start of January, and then steadily round.
// Counted from 0 on 1 January, and ignoring the leap day, as the band does.
export const dayOfYear = (date: Date) => Math.min(364, Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / 86400000));

export const dayAngle = (day: number) => ((100.0 + day * (360 / 365.25)) * Math.PI) / 180;
// Aries begins when the Earth is at longitude 180, because that is when the Sun, seen from here, is at 0.
export const signAngle = (index: number) => ((180 + index * 30) * Math.PI) / 180;

function engrave(band: Band, width: number, draw: (pen: ReturnType<typeof makePen>) => void) {
  const unit = width / (TURN * band.radius);
  const height = Math.ceil(band.height * unit);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.fillStyle = context.strokeStyle = "#fff";
  context.lineCap = "round";
  context.textAlign = "center";
  context.textBaseline = "middle";
  draw(makePen(context, unit, width, height));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 12;
  return texture;
}

// Drawing in world units, with y measured from the hoop's middle, upward.
function makePen(context: CanvasRenderingContext2D, unit: number, width: number, rowHeight: number) {
  const x = (angle: number) => ((((angle % TURN) + TURN) % TURN) / TURN) * width;
  const y = (height: number) => rowHeight / 2 - height * unit;
  return {
    ring(height: number, thickness: number) {
      context.fillRect(0, y(height) - (thickness * unit) / 2, width, thickness * unit);
    },
    tick(angle: number, from: number, to: number, thickness: number) {
      context.fillRect(x(angle) - (thickness * unit) / 2, y(to), thickness * unit, (to - from) * unit);
    },
    // Local units across the panel. Going round the band runs right to left from inside, so it is drawn flipped to read properly.
    panel(angle: number, height: number, draw: (local: { text: (words: string, at: number, size: number, spacing: number, font: string) => void; figure: (stars: [number, number][], lines: [number, number][], at: number, across: number, tall: number) => void }) => void) {
      for (const offset of [0, -width, width]) {
        context.save();
        context.translate(x(angle) + offset, y(height));
        context.scale(-unit, unit);
        draw({
          text(words, at, size, spacing, font) {
            context.font = `${font} ${size * 10}px ${FONT}`;
            const letters = [...words];
            const widths = letters.map((letter) => context.measureText(letter).width / 10 + spacing);
            let along = at - widths.reduce((sum, value) => sum + value, 0) / 2;
            letters.forEach((letter, index) => {
              context.save();
              context.translate(along + widths[index] / 2, 0);
              context.scale(0.1, 0.1);
              context.fillText(letter, 0, 0);
              context.restore();
              along += widths[index];
            });
          },
          figure(stars, lines, at, across, tall) {
            const point = ([px, py]: [number, number]): [number, number] => [at + px * across, -py * tall];
            context.lineWidth = 0.008;
            for (const [a, b] of lines) {
              context.beginPath();
              context.moveTo(...point(stars[a]));
              context.lineTo(...point(stars[b]));
              context.stroke();
            }
            stars.forEach((star, index) => {
              context.beginPath();
              context.arc(...point(star), index === 0 ? 0.026 : 0.016, 0, TURN);
              context.fill();
            });
          }
        });
        context.restore();
      }
    }
  };
}

export function makeBandMasks(width: number) {
  const seasons = engrave(SEASONS, width, (pen) => {
    const edge = SEASONS.height / 2;
    pen.ring(edge - 0.05, 0.009);
    pen.ring(-edge + 0.05, 0.009);
    ["Spring", "Summer", "Autumn", "Winter"].forEach((season, index) => {
      const start = Math.PI + (index * Math.PI) / 2;
      pen.tick(start, -edge + 0.05, edge - 0.05, 0.012);
      pen.panel(start + Math.PI / 4, 0, ({ text }) => text(season.toUpperCase(), 0, 0.26, 0.2, "300"));
      for (let month = 1; month < 3; month++) pen.tick(start + (month * Math.PI) / 6, -edge + 0.05, -edge + 0.15, 0.008);
    });
  });
  const zodiac = engrave(ZODIAC, width, (pen) => {
    const edge = ZODIAC.height / 2;
    pen.ring(edge - 0.05, 0.009);
    pen.ring(-edge + 0.05, 0.009);
    SIGNS.forEach((sign, index) => {
      pen.tick(signAngle(index), -edge + 0.05, edge - 0.05, 0.012);
      pen.panel(signAngle(index) + Math.PI / 12, 0, ({ text, figure }) => {
        figure(sign.stars, sign.lines, -0.95, 0.42, 0.42);
        text(sign.label, 0.42, 0.36, 0.018, "italic 300");
      });
    });
  });
  const months = engrave(MONTHS, width, (pen) => {
    const edge = MONTHS.height / 2;
    // Degrees along the top, days along the bottom.
    pen.ring(edge - 0.12, 0.008);
    pen.ring(-edge + 0.14, 0.008);
    for (let degree = 0; degree < 360; degree++) pen.tick((degree * Math.PI) / 180, edge - (degree % 10 === 0 ? 0.12 : degree % 5 === 0 ? 0.09 : 0.06), edge - 0.02, degree % 5 === 0 ? 0.008 : 0.006);
    let day = 0;
    MONTH_NAMES.forEach((month, index) => {
      const days = MONTH_DAYS[index];
      pen.tick(dayAngle(day), -edge + 0.03, edge - 0.12, 0.012);
      for (let d = 0; d < days; d++) pen.tick(dayAngle(day + d), -edge + 0.14 - ((d + 1) % 5 === 0 ? 0.1 : 0.06), -edge + 0.14, 0.006);
      pen.panel(dayAngle(day + days / 2), 0.01, ({ text }) => text(month, 0, 0.29, 0.03, "300"));
      day += days;
    });
  });
  return { seasons, zodiac, months };
}

// A strip of the sphere between two latitudes, with uv.x going once round.
export function bandStrip({ elevation, span }: Band, distance: number, segments = 256) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const angle = u * TURN;
    for (const top of [0, 1]) {
      const latitude = ((elevation + (top - 0.5) * span) * Math.PI) / 180;
      const flat = Math.cos(latitude);
      positions.push(distance * flat * Math.cos(angle), distance * Math.sin(latitude), -distance * flat * Math.sin(angle));
      uvs.push(u, top);
    }
    if (i < segments) indices.push(i * 2, i * 2 + 2, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}
