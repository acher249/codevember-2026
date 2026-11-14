// Four webs, each in its own weather and light. They share one way of being spun, hung and shaken: what changes is the
// shape of the web, the silk, what hangs on it, the light behind it and the air around it.

export type Version = "dawn" | "golden" | "moonlit" | "storm";

export type Look = {
  label: string;
  swatch: string[];
  // The web: spokes, turns of the sticky spiral, how far the hub sits off centre (fraction of the radius, up is +), how
  // much wider the spiral is spaced below the hub than above, and the fraction of spiral threads already broken.
  spokes: number;
  turns: number;
  hubLift: number;
  lopsided: number;
  broken: number;
  // Silk: its colour where light falls on it, how wide it is drawn, and how strong its rainbow glints are.
  silk: string;
  width: number;
  glint: number;
  // What hangs on it: drops to the metre of spiral, and their sizes.
  dew: number;
  dropSize: [number, number];
  // Behind it: the sky from top to the horizon, the light (sun or moon), its direction from the web, and the soft blots
  // of out-of-focus leaves and flowers far behind.
  zenith: string;
  horizon: string;
  light: string;
  lightPower: number;
  toLight: [number, number, number];
  blots: string[];
  bokeh: string[];
  // Bark and leaves.
  bark: string;
  leaf: string;
  // What drifts in the air, and the wind's usual strength and gustiness.
  air: "motes" | "pollen" | "fireflies" | "rain";
  wind: number;
  gusts: number;
  spider: "garden" | "golden" | null;
  exposure: number;
  bloom: number;
};

export const LOOKS: Record<Version, Look> = {
  dawn: {
    label: "Dawn",
    swatch: ["#f6c27a", "#7a9a4a"],
    spokes: 30,
    turns: 27,
    hubLift: 0.08,
    lopsided: 1.15,
    broken: 0.02,
    silk: "#f4efe6",
    width: 0.0016,
    glint: 1,
    dew: 26,
    dropSize: [0.006, 0.016],
    zenith: "#41586a",
    horizon: "#d6924e",
    light: "#ffd7a0",
    lightPower: 3.2,
    toLight: [0.35, 0.22, -1],
    blots: ["#2c4a1c", "#5f7a2a", "#a07a3a", "#16260f"],
    bokeh: ["#ffe2a8", "#fff1cf", "#d9f0a0"],
    bark: "#5b4634",
    leaf: "#6f8f3a",
    air: "motes",
    wind: 0.25,
    gusts: 0.3,
    spider: "garden",
    exposure: 1.05,
    bloom: 0.45
  },
  golden: {
    label: "Golden silk",
    swatch: ["#e8b92c", "#1f5a3a"],
    spokes: 44,
    turns: 46,
    hubLift: 0.3,
    lopsided: 1.6,
    broken: 0.03,
    silk: "#f2c440",
    width: 0.0019,
    glint: 0.8,
    dew: 14,
    dropSize: [0.007, 0.022],
    zenith: "#123524",
    horizon: "#5f9a4c",
    light: "#fff0b8",
    lightPower: 2.6,
    toLight: [-0.3, 0.55, -1],
    blots: ["#0f3a20", "#25662e", "#6a9a32", "#06180d"],
    bokeh: ["#f9f3b0", "#c9f27a", "#fff8d8"],
    bark: "#3d2f23",
    leaf: "#2f6b2c",
    air: "pollen",
    wind: 0.15,
    gusts: 0.2,
    spider: "golden",
    exposure: 1,
    bloom: 0.4
  },
  moonlit: {
    label: "Moonlit",
    swatch: ["#1b2a4a", "#c9dcff"],
    spokes: 32,
    turns: 36,
    hubLift: 0.1,
    lopsided: 1.2,
    broken: 0.03,
    silk: "#cfe0ff",
    width: 0.0016,
    glint: 1.3,
    dew: 30,
    dropSize: [0.007, 0.018],
    zenith: "#050a18",
    horizon: "#1d3156",
    light: "#d6e4ff",
    lightPower: 2.2,
    toLight: [0.25, 0.4, -1],
    blots: ["#0d1a2c", "#16304a", "#24405e", "#0a1220"],
    bokeh: ["#c9f56a", "#e7ff9a", "#9fd0ff"],
    bark: "#2a2a30",
    leaf: "#22382e",
    air: "fireflies",
    wind: 0.15,
    gusts: 0.2,
    spider: "garden",
    exposure: 1.1,
    bloom: 0.7
  },
  storm: {
    label: "Storm",
    swatch: ["#3b4a52", "#9fc1c9"],
    spokes: 26,
    turns: 28,
    hubLift: 0.06,
    lopsided: 1.25,
    broken: 0.12,
    silk: "#e6eef0",
    width: 0.0017,
    glint: 0.6,
    dew: 40,
    dropSize: [0.008, 0.022],
    zenith: "#161e24",
    horizon: "#56706f",
    light: "#dfe9ec",
    lightPower: 1.6,
    toLight: [0.1, 0.6, -1],
    blots: ["#1f3328", "#344f3c", "#5d7465", "#18221d"],
    bokeh: ["#e8f4f4", "#c8dcdc"],
    bark: "#2b231d",
    leaf: "#2d4630",
    air: "rain",
    wind: 0.7,
    gusts: 1,
    spider: "garden",
    exposure: 0.95,
    bloom: 0.35
  }
};

export const KINDS = Object.keys(LOOKS) as Version[];
export const VERSIONS = (Object.keys(LOOKS) as Version[]).map((value) => ({
  value,
  label: LOOKS[value].label,
  swatch: LOOKS[value].swatch
}));
