import type { Look } from "./scene";

// Five worlds out of focus behind the statues, each its own light.
export const LOOKS: Record<"ember" | "storm" | "neon" | "gold" | "eclipse", Look> = {
  // Firelight: a dark umber night, distant fires and lanterns burning orange far behind, their warmth along every edge.
  ember: {
    zenith: "#0b0605",
    horizon: "#2a130a",
    light: "#ff8a3c",
    power: 1.4,
    toLight: [0.35, 0.18, -1],
    blots: ["#3a1a0c", "#5a2a10", "#140806"],
    bokeh: ["#ff9a4a", "#ffc070", "#ff6a2a"],
    count: 110,
    rim: 3.2,
    fill: "#e6b48a",
    fillPower: 2.0,
    ambient: "#2a1a14",
    floor: "#1a0f0a",
    exposure: 1.05,
    bloom: 0.4,
    notes: "Statues of veiled figures, close, against a night of distant fires gone to soft light."
  },
  // Storm: cold slate, rain-dark, a silver break in the cloud behind them and a few cold lights far off.
  storm: {
    zenith: "#1a2028",
    horizon: "#4a5664",
    light: "#d8e6ff",
    power: 1.1,
    toLight: [-0.4, 0.35, -1],
    blots: ["#2a333e", "#55606c", "#1a1f26"],
    bokeh: ["#bcd0ea", "#e8f0ff"],
    count: 50,
    rim: 2.6,
    fill: "#c8d4e4",
    fillPower: 2.6,
    ambient: "#3a4450",
    floor: "#22282f",
    exposure: 1.0,
    bloom: 0.3,
    notes: "Statues of veiled figures, close, before a cold storm-dark sky breaking silver behind them."
  },
  // Neon: a city far off at night, teal and magenta lights blurred to discs, a cyan edge on the stone.
  neon: {
    zenith: "#05060c",
    horizon: "#121630",
    light: "#47e0ff",
    power: 1.2,
    toLight: [0.5, 0.12, -1],
    blots: ["#1a1040", "#0e3040", "#080814"],
    bokeh: ["#ff3fa8", "#3fe8ff", "#7a5cff", "#ffb04a"],
    count: 160,
    rim: 3,
    fill: "#d8c4e4",
    fillPower: 1.8,
    ambient: "#14142a",
    floor: "#0a0a12",
    exposure: 1.1,
    bloom: 0.55,
    notes: "Statues of veiled figures, close, before a city at night blurred to discs of teal and magenta."
  },
  // Gold: dunes at the last of the sun, sand in the air, the low sun right behind them blazing through the haze.
  gold: {
    zenith: "#6a5a4a",
    horizon: "#d8a462",
    light: "#ffd28a",
    power: 2.2,
    toLight: [-0.15, 0.08, -1],
    blots: ["#b07a40", "#8a5a30", "#c89a5a"],
    bokeh: ["#ffe0a0", "#fff2d0"],
    count: 60,
    rim: 3.6,
    fill: "#ffe2c0",
    fillPower: 2.8,
    ambient: "#8a6a4a",
    floor: "#7a5a3a",
    exposure: 1.0,
    bloom: 0.45,
    notes: "Statues of veiled figures, close, with dunes and a low sun behind them gone to golden haze."
  },
  // Eclipse: almost nothing, a vast pale halo behind them, dust catching it.
  eclipse: {
    zenith: "#030304",
    horizon: "#0a0a0c",
    light: "#f2f0ff",
    power: 1.6,
    toLight: [0, 0.3, -1],
    blots: ["#101014", "#18181e", "#050506"],
    bokeh: ["#e8e8ff", "#ffffff"],
    count: 70,
    rim: 3.4,
    fill: "#c8ccdc",
    fillPower: 1.32,
    ambient: "#0c0c10",
    floor: "#08080a",
    exposure: 1.05,
    bloom: 0.5,
    notes: "Statues of veiled figures, close, in near darkness before a vast pale halo."
  }
};

// Other colours for the world behind, chosen in the panel; the first choice there is the version's own.
export const COLOURS: Record<"ash" | "midnight" | "crimson", Look> = {
  // Ash: a pale warm grey haze, soft white light behind, like smoke lit by day.
  ash: {
    ...LOOKS.ember,
    zenith: "#3a3632",
    horizon: "#8a827a",
    light: "#fff4e6",
    power: 1.3,
    blots: ["#6a625a", "#9a9288", "#4a443e"],
    bokeh: ["#fff6ea", "#e8e0d4"],
    count: 70,
    fill: "#f2e8dc",
    fillPower: 1.8,
    ambient: "#5a544e",
    floor: "#3a3530",
    exposure: 1.0,
    bloom: 0.35,
    notes: "Statues of veiled figures, close, before a pale haze of ash lit from behind."
  },
  // Midnight: deep blue, silver light behind, cold sparks far off.
  midnight: {
    ...LOOKS.ember,
    zenith: "#03050c",
    horizon: "#0e1a36",
    light: "#9cc4ff",
    power: 1.4,
    blots: ["#10204a", "#1a3466", "#060a18"],
    bokeh: ["#a8c8ff", "#e0ecff", "#6a9cff"],
    count: 110,
    fill: "#b8c8e8",
    fillPower: 1.6,
    ambient: "#101a30",
    floor: "#070b16",
    exposure: 1.05,
    bloom: 0.45,
    notes: "Statues of veiled figures, close, before a deep blue night of distant cold lights."
  },
  // Crimson: dark red, a red glow behind, embers drifting.
  crimson: {
    ...LOOKS.ember,
    zenith: "#0a0203",
    horizon: "#3a0a0c",
    light: "#ff4a3a",
    power: 1.5,
    blots: ["#5a0e10", "#801a16", "#1a0406"],
    bokeh: ["#ff5a40", "#ff8a5a", "#c81a20"],
    count: 120,
    fill: "#e8a89a",
    fillPower: 1.7,
    ambient: "#2a0a0a",
    floor: "#140405",
    exposure: 1.05,
    bloom: 0.45,
    notes: "Statues of veiled figures, close, before a dark red glow, embers drifting."
  }
};
