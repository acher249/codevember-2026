// The Codevember prompt list, and which days have been built. Safe to import from server components.
// To add a day: build it in its own NN-word/ directory, add it to registry.ts, add its blurb to LIVE here, and a poster at public/posters/NN-word.jpg.

export type CodevemberDay = {
  day: number;
  word: string;
  live: boolean;
  blurb?: string;
};

const WORDS = [
  "Fold",
  "Shatter",
  "Melt",
  "Tangle",
  "Moss",
  "Orrery",
  "Hollow",
  "Tesseract",
  "Membrane",
  "Caustic",
  "Rust",
  "Feather",
  "Labyrinth",
  "Tension",
  "Mirage",
  "Spore",
  "Kelp",
  "Pendulum",
  "Erosion",
  "Cocoon",
  "Bolt",
  "Echo",
  "Magma",
  "Nest",
  "Veil",
  "Anamorph",
  "Burrow",
  "Hive",
  "Portal",
  "Dissolve"
];

const LIVE: Record<number, string> = {
  1: "A strip of countryside printed on a paper map, with a river running through it and a flock on the loose. Fold it by its creases, or watch it become a dome, a dart or a box.",
  2: "The sky is a pane of glass. Throw a stone at it and it comes down in pieces, cloud by cloud, onto a frozen lake where deer scatter. There is a night behind it, and gravity runs both ways.",
  3: "Liquid metal swelling and dripping off a ring into a mirror, ray-traced to the pixel. Pull a drop away, throw it, and splash the surface.",
  4: "A snarl of lacquered cord hanging in a shaft of light. Pull a loose end and the whole knot answers.",
  5: "A ledge high on a cliff, over a forest full of birds, deep in old moss. Get close to it, carry a stone, or send one over the edge.",
  6: "A clockwork solar system in brass, with every tooth of every gear doing its job. Turn the crank, pull it apart, drag the Sun and let the pieces chase it, or turn the whole machine into a constellation.",
  7: "A giant peach afloat at sunrise, with sharks circling below. Slice it open, then grab the stone and pull it out by its dripping strands.",
  8: "A cube from the fourth dimension, turning itself inside out.",
  9: "A smooth clay skin over simple shapes, with another skin under it, for ever. Swipe and it peels away in curls that float off."
};

const CODEVEMBER_YEAR = 2026;

export const days: CodevemberDay[] = WORDS.map((word, index) => ({
  day: index + 1,
  word,
  live: index + 1 in LIVE,
  blurb: LIVE[index + 1]
}));

export const daySlug = (day: Pick<CodevemberDay, "day" | "word">) =>
  `${String(day.day).padStart(2, "0")}-${day.word.toLowerCase()}`;

export const dayHref = (day: Pick<CodevemberDay, "day" | "word">) => `/${daySlug(day)}/`;

export const dayFromSlug = (slug: string) => days.find((day) => daySlug(day) === slug);

export const dayFromPath = (pathname: string) => {
  const slug = pathname.replace(/^\//, "").replace(/\/$/, "");
  return slug ? dayFromSlug(slug) : undefined;
};

// The prompt for the viewer's local date, or undefined outside November of the challenge year.
export const promptDayFor = (date: Date) =>
  date.getFullYear() === CODEVEMBER_YEAR && date.getMonth() === 10 ? date.getDate() : undefined;
