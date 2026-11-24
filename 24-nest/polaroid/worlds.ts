// The nests, one per level, in turn. Each is a whole little world: its own tree or ledge, light, sky, chicks and Mum.
// Centimetres throughout; the nest's rim sits at the origin.

export type BirdLook = {
  // Body length without the tail, and the head's size against it.
  size: number;
  head: number;
  // Beak length and depth, and whether it hooks (an owl's).
  beak: [number, number];
  hooked: boolean;
  eye: number;
  // Feather colours: back, breast, belly, crown, face, wing, wing bar, tail; beak, eye, legs.
  back: string;
  breast: string;
  belly: string;
  crown: string;
  face: string;
  wing: string;
  bar: string;
  tail: string;
  bill: string;
  iris: string;
  legs: string;
  // How much the feathers are barred or spotted (owl, pigeon wings), and an iridescent neck (pigeon).
  bars: number;
  spots: number;
  sheen: number;
  // A pale facial disc round big eyes (owl).
  disc: number;
};

export type ChickLook = {
  // Body radii, head radius, beak size.
  body: [number, number, number];
  head: number;
  beak: number;
  // Down: root and tip colours, length, how thick; skin showing between.
  root: string;
  tip: string;
  skin: string;
  down: number;
  density: number;
  // The gape: the flanges at the corners of the mouth and the mouth inside.
  flange: string;
  mouth: string;
  bill: string;
  // An owlet does not gape wide; it bobs and hisses.
  gape: number;
  eye: number;
  speckle: number;
};

export type World = {
  key: "blossom" | "city" | "dusk";
  label: string;
  // Toward the sun, its colour and strength; the sky and ground fill.
  sun: [number, number, number];
  sunColour: string;
  sunPower: number;
  sky: string;
  ground: string;
  fill: number;
  // How strongly the light is broken up by leaves, and the size of the gaps.
  dapple: number;
  dappleSize: number;
  // Specks in the air and shafts of light.
  air: string;
  shafts: number;
  exposure: number;
  nest: { twig: string; grass: string; mud: string; moss: number; litter: boolean; sticks: number; radius: number };
  chick: ChickLook;
  chicks: number;
  mum: BirdLook;
  ambience: "song" | "city" | "dusk";
};

export const WORLDS: World[] = [
  {
    key: "blossom",
    label: "Blossom",
    sun: [-0.55, 0.62, -0.56],
    sunColour: "#ffe3bd",
    sunPower: 3.4,
    sky: "#c4d8f4",
    ground: "#6a6a40",
    fill: 1.25,
    dapple: 0.75,
    dappleSize: 5,
    air: "#fff0d8",
    shafts: 1,
    exposure: 1,
    nest: { twig: "#8a7a62", grass: "#c2ab78", mud: "#5a4630", moss: 0.7, litter: false, sticks: 1, radius: 8 },
    chick: {
      body: [2.35, 2.15, 2.75],
      head: 1.5,
      beak: 1.15,
      root: "#6e6256",
      tip: "#e2d8cc",
      skin: "#d9a48f",
      down: 0.62,
      density: 1.35,
      flange: "#ffd84a",
      mouth: "#ff6a2a",
      bill: "#f6c64e",
      gape: 1,
      eye: 0.42,
      speckle: 0.6
    },
    chicks: 3,
    mum: {
      size: 13,
      head: 1,
      beak: [1.7, 0.55],
      hooked: false,
      eye: 0.5,
      back: "#6e6458",
      breast: "#d0642c",
      belly: "#e9ddc9",
      crown: "#3c3833",
      face: "#4a443e",
      wing: "#5e564d",
      bar: "#8d847a",
      tail: "#3d3934",
      bill: "#e2a83a",
      iris: "#1a120c",
      legs: "#8a6a58",
      bars: 0,
      spots: 0,
      sheen: 0,
      disc: 0
    },
    ambience: "song"
  },
  {
    key: "city",
    label: "City",
    sun: [0.78, 0.32, 0.4],
    sunColour: "#ffb070",
    sunPower: 3.6,
    sky: "#8fa6c8",
    ground: "#6a4a3a",
    fill: 0.75,
    dapple: 0.15,
    dappleSize: 9,
    air: "#ffd2a0",
    shafts: 0.8,
    exposure: 1.05,
    nest: { twig: "#7a6a58", grass: "#b49d72", mud: "#4e4034", moss: 0, litter: true, sticks: 1.3, radius: 8.6 },
    chick: {
      body: [2.55, 2.25, 2.9],
      head: 1.6,
      beak: 1.45,
      root: "#d7a83a",
      tip: "#fff0a8",
      skin: "#e8a690",
      down: 0.95,
      density: 0.7,
      flange: "#e8c8a8",
      mouth: "#d86a5a",
      bill: "#4a3a3a",
      gape: 0.75,
      eye: 0.4,
      speckle: 0
    },
    chicks: 2,
    mum: {
      size: 15,
      head: 0.85,
      beak: [1.5, 0.5],
      hooked: false,
      eye: 0.45,
      back: "#8a8f9a",
      breast: "#7d7f8c",
      belly: "#a3a6b2",
      crown: "#6e7384",
      face: "#6e7384",
      wing: "#9ca1ab",
      bar: "#2a2a30",
      tail: "#5c606c",
      bill: "#3a3036",
      iris: "#e06a1a",
      legs: "#d06a6a",
      bars: 0.8,
      spots: 0,
      sheen: 1,
      disc: 0
    },
    ambience: "city"
  },
  {
    key: "dusk",
    label: "Dusk",
    sun: [0.25, 0.14, -0.96],
    sunColour: "#ff8a5a",
    sunPower: 2.4,
    sky: "#5a6a9a",
    ground: "#2a2020",
    fill: 1.1,
    dapple: 0.4,
    dappleSize: 7,
    air: "#ffc8a0",
    shafts: 0.7,
    exposure: 1.15,
    nest: { twig: "#6e6050", grass: "#9a8a6a", mud: "#3e3228", moss: 1, litter: false, sticks: 1.6, radius: 9 },
    chick: {
      body: [2.6, 2.5, 2.7],
      head: 1.85,
      beak: 0.75,
      root: "#cfc6bb",
      tip: "#fbf8f2",
      skin: "#e8d0c0",
      down: 1.15,
      density: 1.25,
      flange: "#d8c8b0",
      mouth: "#d46060",
      bill: "#3a3a40",
      gape: 0.35,
      eye: 0.62,
      speckle: 0
    },
    chicks: 3,
    mum: {
      size: 14,
      head: 1.35,
      beak: [1.1, 0.75],
      hooked: true,
      eye: 0.9,
      back: "#7a5a3e",
      breast: "#c8a47c",
      belly: "#e2cfb2",
      crown: "#6a4c34",
      face: "#d8c2a2",
      wing: "#6e5038",
      bar: "#e8d8c0",
      tail: "#5e442e",
      bill: "#c8c0a8",
      iris: "#f2b81a",
      legs: "#d8c8a8",
      bars: 0.5,
      spots: 1,
      sheen: 0,
      disc: 1
    },
    ambience: "dusk"
  }
];
