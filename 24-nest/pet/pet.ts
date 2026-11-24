// The pet inside the egg, and everything its screen shows. A 32 × 16 dot matrix and eight icon segments, written here as
// what each dot should be; the screen (lcd.ts) eases its dots toward that, so they leave a ghost as they go. No three.js:
// only the creature, its needs and its little games.
//
// Life runs on compressed time: a heart of hunger every half minute or so, so a few minutes of real time is a whole
// life. Movement steps on a slow tick, as these toys did, never smoothly.

export const COLS = 32;
export const ROWS = 16;
// Each icon is a 12 × 12 segment pattern: feed, light, play, clean along the top; status, nest, mail, alert below.
export const ICON = 12;
export const ICONS = 8;
const FEED = 0;
const LIGHT = 1;
const PLAY = 2;
const CLEAN = 3;
const STATUS = 4;
const NEST = 5;
const MAIL = 6;
const ALERT = 7;

export type Sound = "boot" | "select" | "ok" | "cancel" | "error" | "crack" | "hatch" | "twig" | "chomp" | "full" | "win" | "lose" | "turn" | "flush" | "plop" | "alert" | "leave" | "note" | "light" | "reset" | "happy";

type Sprite = { w: number; h: number; bits: Uint8Array };
const sprite = (rows: string[]): Sprite => {
  const w = Math.max(...rows.map((r) => r.length));
  const bits = new Uint8Array(w * rows.length);
  rows.forEach((r, y) => [...r].forEach((c, x) => (bits[y * w + x] = c === "#" ? 1 : 0)));
  return { w, h: rows.length, bits };
};

// The creature: a round dark nest-builder with one big eye, a sprout on its head, a short beak, a pale wing and stubby
// feet. Filled, with the eye and wing left clear, so it reads at a glance. Facing right.
const BODY = [
  "......#.#....",
  ".......#.....",
  "....#####....",
  "..#########..",
  ".#####...###.",
  ".#####.#.####",
  "######...####",
  "##.....####..",
  "###...#####..",
  ".#########...",
  "..#######....",
  "..#.....#...."
];
const swap = (rows: string[], at: Record<number, string>) => rows.map((r, i) => at[i] ?? r);
const BIRD = {
  stand: sprite(BODY),
  step: sprite(swap(BODY, { 11: "...#...#....." })),
  // Beak open, to eat.
  open: sprite(swap(BODY, { 4: ".#####...####", 5: ".#####.#.##..", 6: "######...####" })),
  // Eye shut in a smile.
  happy: sprite(swap(BODY, { 4: ".######.####.", 5: ".#####.#.####", 6: "#############" })),
  // Eye cast down, a tear, the sprout drooping.
  sad: sprite(swap(BODY, { 0: ".............", 1: ".....##......", 4: ".###########.", 5: ".#####...####", 6: "######.#.####", 8: "###...#.###.." })),
  // Seen from the front, for the guessing game: two eyes, a beak's tip.
  front: sprite([
    "......#.#....",
    ".......#.....",
    "....#####....",
    "..#########..",
    ".##...#...##.",
    ".##.#.#.#.##.",
    "###...#...###",
    "######.######",
    "#############",
    ".###########.",
    "..#########..",
    "...#.....#..."
  ]),
  // Asleep, sitting low, eye shut.
  sleep: sprite(["....#####....", "..#########..", ".###########.", ".####...#####", ".############", "##.....####..", ".#########...", "..#######...."])
};
// Its bindle, a bundle on a stick over the shoulder, drawn behind it as it leaves.
const BINDLE = sprite(["###.....", "####....", "###.#...", ".....#..", "......#."]);
const EGG = sprite(["...####...", "..#....#..", ".#......#.", ".#..#...#.", "#........#", "#...#..#.#", "#........#", "#..#.....#", "#.....#..#", ".#......#.", "..#....#..", "...####..."]);
// Cracks spreading across the egg, one more line each tap.
const CRACKS = [
  [
    [4, 5],
    [5, 6]
  ],
  [
    [4, 5],
    [5, 6],
    [6, 5],
    [7, 6],
    [3, 6]
  ],
  [
    [4, 5],
    [5, 6],
    [6, 5],
    [7, 6],
    [3, 6],
    [2, 5],
    [8, 5],
    [1, 6],
    [6, 4]
  ]
];
const POOP = sprite(["..#..", ".#.#.", ".###.", "#.#.#", "#####"]);
const MEAL = sprite([".#.##.", "#.##.#", "######", "#....#", ".####."]);
const SNACK = sprite(["..#..", ".#...", ".###.", "#.#.#", "#####", ".###."]);
const HEART = sprite([".#.#.", "#####", "#####", ".###.", "..#.."]);
const HOLLOW = sprite([".#.#.", "#.#.#", "#...#", ".#.#.", "..#.."]);
const FORK = sprite(["#.#.#", "#.#.#", "#####", "..#..", "..#.."]);
const SMILE = sprite([".###.", "#.#.#", "#####", "#...#", ".###."]);
const NOTE = sprite(["#######", "##...##", "#.#.#.#", "#..#..#", "#######"]);
const TWIG = sprite(["##...", "..###"]);

// The nest, as a bowl of crossed twigs. It is laid down dot by dot in a fixed scattered order as twigs are brought.
const NEST_SHAPE = [".#..#.#..#..#.", "#.##.#.##.#.##", ".############.", "..##########..", "...########..."];
const NEST_X = 9;
const NEST_Y = 11;
const NEST_ORDER = (() => {
  const dots: [number, number][] = [];
  NEST_SHAPE.forEach((r, y) => [...r].forEach((c, x) => c === "#" && dots.push([x, y])));
  // Bottom first, so it grows up from the floor, shuffled within each row.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return dots.map((d) => ({ d, k: (4 - d[1]) * 10 + random() * 14 })).sort((a, b) => a.k - b.k).map((e) => e.d);
})();
const TWIGS = 5;

// The icons, our own: a bowl of seeds, a bulb, a ball, a drop, a heart on a scale, a nest, a letter, an alert.
const ICON_ART = [
  ["............", "....#..#....", "...#..#.....", "....#..#....", "............", "############", "#.#..#..#..#", ".#........#.", "..#......#..", "...######...", "............", "............"],
  ["....####....", "...#....#...", "..#..##..#..", "..#.#.....#.", "..#.......#.", "...#....#...", "....#..#....", "....####....", "....####....", ".....##.....", "............", "............"],
  ["....####....", "..##.##.##..", ".#..#..#..#.", ".#.#....#.#.", "#..#....#..#", "#.#......#.#", "#.#......#.#", "#..#....#..#", ".#.#....#.#.", ".#..#..#..#.", "..##.##.##..", "....####...."],
  [".....#......", ".....#......", "....###.....", "....###...#.", "...#####.###", "...##.##..#.", "..##.####...", "..##.####...", "..###.###...", "...#####....", "....###.....", "............"],
  ["............", ".###....###.", "#...#..#...#", "#....##....#", "#..........#", ".#........#.", "..#......#..", "...#....#...", "....#..#....", ".....##.....", "............", "############"],
  ["............", "............", "...#....#...", "....#..#....", "#..##..##..#", ".#.#.##.#.#.", "############", "#.#.#.#.#.#.", ".##########.", "..########..", "...######...", "............"],
  ["............", "............", "############", "##........##", "#.#......#.#", "#..#....#..#", "#...#..#...#", "#....##....#", "#..........#", "############", "............", "............"],
  ["..########..", ".#........#.", "#....##....#", "#....##....#", "#....##....#", "#....##....#", "#..........#", "#....##....#", ".#........#.", "..####.###..", "......##....", ".......#...."]
].map(sprite);

// A 3 × 5 font for words and numbers.
const GLYPHS: Record<string, string> = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110", E: "111100110100111", F: "111100110100100",
  G: "011100101101011", H: "101101111101101", I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100", Q: "010101101110011", R: "110101110101101",
  S: "011100010001110", T: "111010010010010", U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111", "0": "111101101101111", "1": "010110010010111", "2": "110001010100111", "3": "110001010001110",
  "4": "101101111001001", "5": "111100110001110", "6": "011100111101111", "7": "111001010010010", "8": "111101111101111", "9": "111101111001110",
  ".": "000000000000010", ",": "000000000010100", "!": "010010010000010", "?": "110001010000010", ">": "100010001010100", "<": "001010100010001",
  "%": "101001010100101", " ": "000000000000000", "-": "000000111000000"
};
export const NOTE_TEXT = "GONE TO FIND A NICER NEST. BYE";

type Mode = "off" | "boot" | "egg" | "hatch" | "life" | "leaving" | "gone";
type Screen = "home" | "feed" | "eat" | "status" | "game" | "clean" | "sit" | "nomail";

export class Pet {
  // What each dot should show (0 or 1), and how strongly each icon is lit (its unlit pattern faintly shows anyway).
  readonly dots = new Uint8Array(COLS * ROWS);
  readonly icons = new Float32Array(ICONS);
  readonly sounds: Sound[] = [];
  mode: Mode = "off";
  screen: Screen = "home";
  // Seconds since this mode began, on the real clock, for animation; and the pet's own age, on the life clock.
  clock = 0;
  age = 0;
  hunger = 4;
  happy = 4;
  poops = 0;
  nest = 0;
  lights = true;
  selected = -1;
  // How many times the egg has been tapped, and the cracks shown.
  taps = 0;
  // Where the creature is (its left edge), which way it faces, what it is doing.
  x = 16;
  facing = 1;
  task: "hello" | "wander" | "fetch" | "away" | "bring" | "drop" | "nap" = "hello";
  taskTime = 0;
  carrying = false;
  goal = 18;
  pooAt = 22;
  neglect = 0;
  sinceAlert = 99;
  // The tick the creature steps on, and per screen state.
  private tick = 0;
  private screenTime = 0;
  private choice = 0;
  private food: "meal" | "snack" = "meal";
  private bites = 0;
  private round = 0;
  private wins = 0;
  private guess = -1;
  private looks = 0;
  private statusPage = 0;
  private random = Math.random;
  private nextPoop = 40;

  // The tab pulled: the screen tests every segment, then an egg.
  power() {
    if (this.mode !== "off") return;
    this.setMode("boot");
    this.sounds.push("boot");
  }

  // The pin in the back, or C held: a new egg, after a quick test of the segments.
  reset() {
    if (this.mode === "off") return;
    this.hunger = 4;
    this.happy = 4;
    this.poops = 0;
    this.nest = 0;
    this.lights = true;
    this.selected = -1;
    this.taps = 0;
    this.age = 0;
    this.neglect = 0;
    this.screen = "home";
    this.setMode("boot");
    this.sounds.push("reset");
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    this.clock = 0;
    this.tick = 0;
  }

  private setScreen(screen: Screen) {
    this.screen = screen;
    this.screenTime = 0;
  }

  // A, B or C pressed (0, 1, 2).
  press(button: number) {
    const m = this.mode;
    if (m === "off" || m === "boot") return;
    if (m === "egg") {
      this.taps++;
      this.sounds.push("crack");
      if (this.taps >= 4) this.hatch();
      return;
    }
    if (m === "hatch" || m === "leaving") return;
    if (m === "gone") {
      // A, C: nothing to do here but read; B on the letter reads it again.
      if (button === 0) this.cycle();
      else if (button === 1 && this.selected === MAIL) {
        this.clock = 0;
        this.sounds.push("note");
      } else this.sounds.push(button === 2 ? "cancel" : "error");
      return;
    }
    const s = this.screen;
    if (s === "home") {
      if (button === 0) this.cycle();
      else if (button === 1) this.choose();
      else {
        this.selected = -1;
        this.sounds.push("cancel");
      }
      return;
    }
    if (button === 2 && s !== "eat" && s !== "clean") {
      this.setScreen("home");
      this.sounds.push("cancel");
      return;
    }
    if (s === "feed") {
      if (button === 0) {
        this.choice = 1 - this.choice;
        this.sounds.push("select");
      } else {
        this.food = this.choice === 0 ? "meal" : "snack";
        if (this.food === "meal" && this.hunger >= 4) {
          this.sounds.push("full");
          this.setScreen("eat");
          this.bites = -1;
        } else {
          this.sounds.push("ok");
          this.setScreen("eat");
          this.bites = 0;
        }
      }
    } else if (s === "status") {
      if (button === 0 || button === 1) {
        this.statusPage = 1 - this.statusPage;
        this.sounds.push("select");
      }
    } else if (s === "game") {
      if (this.guess < 0 && button !== 2 && this.screenTime > 0.4) {
        this.guess = button;
        this.looks = this.random() < 0.5 ? 0 : 1;
        this.screenTime = 0;
        this.sounds.push("turn");
      }
    } else if (s === "nomail" || s === "sit") {
      this.setScreen("home");
      this.sounds.push("cancel");
    }
  }

  private cycle() {
    // The alert is only a light: the cursor steps over it.
    this.selected = (this.selected + 1) % ALERT;
    this.sounds.push("select");
  }

  private choose() {
    switch (this.selected) {
      case FEED:
        this.choice = 0;
        this.setScreen("feed");
        this.sounds.push("ok");
        break;
      case LIGHT:
        this.lights = !this.lights;
        this.sounds.push("light");
        break;
      case PLAY:
        this.round = 0;
        this.wins = 0;
        this.guess = -1;
        this.setScreen("game");
        this.sounds.push("ok");
        break;
      case CLEAN:
        this.setScreen("clean");
        this.sounds.push("flush");
        break;
      case STATUS:
        this.statusPage = 0;
        this.setScreen("status");
        this.sounds.push("ok");
        break;
      case NEST:
        this.setScreen("sit");
        this.sounds.push("ok");
        break;
      case MAIL:
        this.setScreen("nomail");
        this.sounds.push("ok");
        break;
      default:
        this.sounds.push("error");
    }
  }

  private hatch() {
    this.setMode("hatch");
    this.sounds.push("hatch");
  }

  // The pet's needs, on the life clock (speed scales it), and its moves, on the real one.
  step(dt: number, speed: number) {
    this.clock += dt;
    this.screenTime += dt;
    this.sinceAlert += dt;
    const m = this.mode;
    if (m === "boot" && this.clock > 1.4) this.setMode("egg");
    else if (m === "egg" && this.clock > 14) this.hatch();
    else if (m === "hatch" && this.clock > 3.2) {
      this.setMode("life");
      this.x = 10;
      this.facing = 1;
      this.task = "hello";
      this.taskTime = 0;
      this.carrying = false;
      this.nextPoop = 45;
    } else if (m === "life") this.live(dt, speed);
    else if (m === "leaving") {
      if (this.ticked(dt, 0.32)) this.x++;
      if (this.x > COLS + 2) {
        this.setMode("gone");
        this.selected = MAIL;
      }
    }
    this.icons.fill(0);
    if (m === "boot") {
      if (this.clock < 0.9) this.icons.fill(1);
    } else if (m !== "off" && m !== "egg" && m !== "hatch") {
      if (this.selected >= 0) this.icons[this.selected] = 1;
      const needy = m === "life" && this.needy();
      if ((needy || m === "gone") && Math.floor(this.clock * 2.5) % 2 === 0) this.icons[m === "gone" ? MAIL : ALERT] = 1;
    }
  }

  private needy() {
    return this.hunger < 1 || this.happy < 1 || this.poops >= 2;
  }

  // True once every `period` seconds, at the tick.
  private ticked(dt: number, period: number) {
    this.tick += dt;
    if (this.tick < period) return false;
    this.tick -= period;
    return true;
  }

  private live(dt: number, speed: number) {
    const life = dt * speed * (this.lights ? 1 : 0.4);
    this.age += life;
    // A heart of hunger every 28 s, of happiness every 36 s; quicker with mess about, none lost in the dark.
    this.hunger = Math.max(0, this.hunger - life / 28);
    if (this.lights) this.happy = Math.max(0, this.happy - (life / 36) * (1 + this.poops * 0.6));
    this.nextPoop -= life;
    if (this.nextPoop <= 0 && this.screen === "home") {
      this.nextPoop = 38 + this.random() * 20;
      if (this.poops < 3) {
        this.poops++;
        this.sounds.push("plop");
      }
    }
    // Wanting something: beeps for you every so often, the alert flashing meanwhile.
    if (this.needy() && this.sinceAlert > 11) {
      this.sinceAlert = 0;
      this.sounds.push("alert");
    }
    // Left with nothing for long enough, it packs up.
    this.neglect = this.hunger <= 0 && this.happy <= 0 ? this.neglect + life : 0;
    if (this.neglect > 12 && this.screen === "home") {
      this.setMode("leaving");
      this.selected = -1;
      this.lights = true;
      this.facing = 1;
      this.sounds.push("leave");
      return;
    }

    const s = this.screen;
    if (s === "eat") {
      if (this.bites < 0) {
        if (this.screenTime > 1.6) this.setScreen("home");
      } else if (this.screenTime > 0.55 * (this.bites + 1) && this.bites < 3) {
        this.bites++;
        this.sounds.push("chomp");
      } else if (this.bites >= 3 && this.screenTime > 2.4) {
        if (this.food === "meal") this.hunger = Math.min(4, this.hunger + 1);
        else {
          this.happy = Math.min(4, this.happy + 1);
          this.hunger = Math.min(4, this.hunger + 0.25);
        }
        this.sounds.push("happy");
        this.setScreen("home");
      }
      return;
    }
    if (s === "clean") {
      if (this.screenTime > 1.7) {
        this.poops = 0;
        this.setScreen("home");
      }
      return;
    }
    if (s === "game") {
      if (this.guess >= 0 && this.screenTime > 1.4) {
        const won = this.guess === this.looks;
        if (won) this.wins++;
        this.sounds.push(won ? "win" : "lose");
        this.round++;
        this.guess = -1;
        this.screenTime = 0;
        if (this.round >= 3) {
          this.round = 3;
          if (this.wins >= 2) this.happy = Math.min(4, this.happy + 1);
          else this.happy = Math.min(4, this.happy + 0.25);
        }
      }
      if (this.round >= 3 && this.screenTime > 2.2) this.setScreen("home");
      return;
    }
    if (s === "sit") {
      if (this.screenTime > 3.2) {
        this.happy = Math.min(4, this.happy + 0.5);
        this.setScreen("home");
      }
      return;
    }
    // Busy building, it scurries; after, it potters.
    const beat = this.nest < 0.999 ? 0.2 : 0.4;
    if (!this.ticked(dt, beat)) return;
    this.taskTime += beat;
    // Building the nest: off the right edge for a twig, back with it to the nest, drop it; five twigs make the nest,
    // about a minute's work.
    const home = NEST_X;
    switch (this.task) {
      case "hello":
        // Fresh out of the shell: it looks about, then sets off for twigs.
        if (this.taskTime > 3) this.task = "fetch";
        else if (Math.round(this.taskTime / beat) % 6 === 0) this.facing = -this.facing;
        break;
      case "fetch":
        this.facing = 1;
        this.x++;
        if (this.x > COLS + 1) {
          this.task = "away";
          this.taskTime = 0;
        }
        break;
      case "away":
        if (this.taskTime > 1.2) {
          this.task = "bring";
          this.carrying = true;
        }
        break;
      case "bring":
        this.facing = -1;
        this.x--;
        if (this.x <= home) {
          this.task = "drop";
          this.taskTime = 0;
        }
        break;
      case "drop":
        if (this.carrying && this.taskTime > 0.4) {
          this.carrying = false;
          this.nest = Math.min(1, this.nest + 1 / TWIGS);
          this.sounds.push("twig");
        }
        if (this.taskTime > 1.2) {
          this.task = this.nest < 0.999 ? "fetch" : "wander";
          this.goal = this.random() < 0.5 ? 0 + Math.floor(this.random() * 6) : 14 + Math.floor(this.random() * 6);
        }
        break;
      case "wander":
        if (this.x === this.goal) {
          if (this.random() < 0.25) {
            this.goal = this.random() < 0.3 ? home : Math.floor(this.random() * 20);
            if (this.goal === home) this.task = "nap";
          }
        } else {
          this.facing = this.goal > this.x ? 1 : -1;
          this.x += this.facing;
        }
        break;
      case "nap":
        if (this.x !== this.goal) {
          this.facing = this.goal > this.x ? 1 : -1;
          this.x += this.facing;
          this.taskTime = 0;
        } else if (this.taskTime > 5) {
          this.task = "wander";
          this.goal = this.random() < 0.5 ? Math.floor(this.random() * 5) : 14 + Math.floor(this.random() * 6);
        }
        break;
    }
  }

  // ---- Drawing -------------------------------------------------------------------------------------------------------

  private set(x: number, y: number, on = 1) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
    this.dots[y * COLS + x] = on;
  }

  private blit(s: Sprite, x: number, y: number, flip = false, on = 1) {
    for (let j = 0; j < s.h; j++)
      for (let i = 0; i < s.w; i++) if (s.bits[j * s.w + i]) this.set(flip ? x + s.w - 1 - i : x + i, y + j, on);
  }

  // Clears a sprite's whole box first, so what is behind does not show through its outline.
  private solid(s: Sprite, x: number, y: number, flip = false) {
    for (let j = 0; j < s.h; j++) {
      let first = -1;
      let last = -1;
      for (let i = 0; i < s.w; i++)
        if (s.bits[j * s.w + i]) {
          if (first < 0) first = i;
          last = i;
        }
      for (let i = first; i >= 0 && i <= last; i++) this.set(flip ? x + s.w - 1 - i : x + i, y + j, 0);
    }
    this.blit(s, x, y, flip);
  }

  private text(s: string, x: number, y: number) {
    for (const c of s) {
      const g = GLYPHS[c] ?? GLYPHS[" "];
      for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j * 3 + i] === "1") this.set(x + i, y + j);
      x += 4;
    }
  }

  private drawNest(amount: number) {
    const shown = Math.round(NEST_ORDER.length * amount);
    for (let k = 0; k < shown; k++) this.set(NEST_X + NEST_ORDER[k][0], NEST_Y + NEST_ORDER[k][1]);
  }

  // The creature standing on the floor (or in the nest), stepping on alternate ticks.
  private drawBird(x: number, kind: keyof typeof BIRD, flip: boolean, lift = 0) {
    const s = BIRD[kind];
    this.solid(s, x, ROWS - s.h - lift, flip);
  }

  draw() {
    this.dots.fill(0);
    const m = this.mode;
    const t = this.clock;
    if (m === "off") return;
    if (m === "boot") {
      // Every segment on, as these toys test their screen, then clear.
      if (t < 0.9) this.dots.fill(1);
      return;
    }
    if (m === "egg") {
      const wobble = t % 2.2 < 0.5 ? (Math.floor(t * 8) % 2 ? 1 : -1) : 0;
      this.blit(EGG, 11 + wobble, 3);
      for (const [cx, cy] of CRACKS[Math.min(this.taps, CRACKS.length) - 1] ?? []) this.set(11 + wobble + cx, 3 + cy);
      return;
    }
    if (m === "hatch") {
      // The top of the shell lifts away, the creature stands up out of the bottom, and hops for joy.
      if (t < 0.6) {
        this.blit(EGG, 11 + (Math.floor(t * 16) % 2), 3);
        for (const [cx, cy] of CRACKS[2]) this.set(11 + cx, 3 + cy);
        return;
      }
      const up = Math.min(8, Math.floor((t - 0.6) * 10));
      const hop = t > 1.6 && Math.floor(t * 3) % 2 === 0 ? 2 : 0;
      this.drawBird(10, t > 1.6 ? "happy" : "stand", false, hop);
      // The shell's halves: the top flying up and off, the bottom split either side.
      const top = sprite(["...####...", "..#....#..", ".#......#.", ".#..#...#.", "#.#.#.#.#."]);
      if (up < 8) this.blit(top, 11 + up, 3 - up * 2);
      this.blit(sprite(["#.#.", "#...", ".#..", "..##"]), 4, 12);
      this.blit(sprite([".#.#", "...#", "..#.", "##.."]), 24, 12);
      return;
    }
    if (m === "leaving") {
      this.drawNest(this.nest);
      const step = this.x % 2 === 0;
      this.drawBird(this.x, step ? "step" : "sad", false);
      this.blit(BINDLE, this.x - 5, ROWS - 12 + 2);
      return;
    }
    if (m === "gone") {
      // The empty nest, a note left in it, and the note's words going by over it.
      this.drawNest(Math.max(this.nest, 0.35));
      this.blit(NOTE, NEST_X + 4, NEST_Y - 2);
      const width = NOTE_TEXT.length * 4 + COLS;
      const at = COLS - Math.floor((t * 4.5) % width);
      this.text(NOTE_TEXT, at, 1);
      return;
    }

    // Lights out: the screen dark, but for a sleeper's z drifting up.
    if (!this.lights) {
      const k = Math.floor(t * 1.5) % 3;
      this.text("Z", 24 + k, 7 - k * 2);
      return;
    }

    const s = this.screen;
    const st = this.screenTime;
    if (s === "feed") {
      this.text(this.choice === 0 ? ">MEAL" : " MEAL", 4, 1);
      this.text(this.choice === 1 ? ">SNACK" : " SNACK", 4, 9);
      return;
    }
    if (s === "eat") {
      if (this.bites < 0) {
        // Not hungry: it turns its head away, side to side.
        this.drawBird(12, "stand", Math.floor(st * 4) % 2 === 0);
        return;
      }
      const food = this.food === "meal" ? MEAL : SNACK;
      // The food at the left, losing a bite at a time from its right side as the creature, facing it, chomps.
      const cut = Math.min(this.bites, 3) * 2;
      for (let j = 0; j < food.h; j++)
        for (let i = 0; i < food.w - cut; i++) if (food.bits[j * food.w + i]) this.set(6 + i, ROWS - food.h + j);
      const chew = this.bites < 3 && Math.floor(st * 5) % 2 === 0;
      this.drawBird(13, this.bites >= 3 ? "happy" : chew ? "open" : "stand", true);
      return;
    }
    if (s === "status") {
      if (this.statusPage === 0) {
        this.blit(FORK, 1, 1);
        this.blit(SMILE, 1, 9);
        for (let k = 0; k < 4; k++) {
          this.blit(this.hunger > k + 0.01 ? HEART : HOLLOW, 8 + k * 6, 1);
          this.blit(this.happy > k + 0.01 ? HEART : HOLLOW, 8 + k * 6, 9);
        }
      } else {
        this.text("AGE", 2, 1);
        this.text(String(Math.floor(this.age / 30)), 18, 1);
        this.text("NEST", 2, 9);
        this.text(`${Math.round(this.nest * 100)}`.padStart(3, " "), 18, 9);
      }
      return;
    }
    if (s === "game") {
      if (this.round >= 3) {
        this.text(this.wins >= 2 ? "WIN" : "LOSE", this.wins >= 2 ? 10 : 8, 1);
        this.drawBird(10, this.wins >= 2 ? "happy" : "sad", false, this.wins >= 2 && Math.floor(st * 3) % 2 === 0 ? 1 : 0);
        return;
      }
      if (this.guess < 0) {
        // Which way will it look? Arrows either side, blinking.
        this.drawBird(10, "front", false);
        if (Math.floor(st * 3) % 2 === 0) {
          this.text("<", 2, 6);
          this.text(">", 27, 6);
        }
        for (let k = 0; k < 3; k++) if (k < this.round) this.set(29, 1 + k * 2);
        return;
      }
      if (st < 0.5) this.drawBird(10, "front", false);
      else {
        const won = this.guess === this.looks;
        this.drawBird(10, won ? "happy" : "stand", this.looks === 0, won && Math.floor(st * 4) % 2 === 0 ? 1 : 0);
      }
      return;
    }
    if (s === "nomail") {
      this.text("NO", 12, 2);
      this.text("MAIL", 8, 9);
      return;
    }

    // The home screen: the nest, droppings, the creature at its work.
    this.drawNest(this.nest);
    for (let k = 0; k < this.poops; k++) {
      const px = [1, 26, 5][k];
      this.blit(POOP, px, ROWS - 5);
      // Stink lines, wavering.
      if (Math.floor(t * 2) % 2 === 0) {
        this.set(px + 1, ROWS - 7);
        this.set(px + 3, ROWS - 8);
      } else {
        this.set(px + 2, ROWS - 7);
        this.set(px + 1, ROWS - 8);
      }
    }
    if (s === "sit") {
      // It settles into the nest, content.
      this.drawBird(NEST_X, st > 0.8 ? "happy" : "stand", false, 2);
      this.drawNest(Math.max(this.nest, 0.2));
      if (st > 1 && Math.floor(st * 2) % 2 === 0) this.blit(HEART, NEST_X + 15, 2);
      return;
    }
    const inNest = (this.task === "nap" || this.task === "drop") && Math.abs(this.x - NEST_X) <= 1;
    const sad = this.hunger < 1 || this.happy < 1;
    const walking = this.task === "fetch" || this.task === "bring" || (this.task !== "drop" && this.task !== "hello" && this.x !== this.goal);
    const kind = this.task === "hello" ? (this.taskTime < 1 ? "happy" : "stand") : this.task === "nap" && inNest && this.clock % 9 > 4 ? "sleep" : walking && this.x % 2 === 0 ? "step" : sad ? "sad" : "stand";
    this.drawBird(this.x, kind, this.facing < 0, inNest ? 2 : 0);
    if (this.carrying) this.blit(TWIG, this.facing > 0 ? this.x + 11 : this.x - 3, ROWS - 12 + 6, this.facing < 0);
    if (inNest) this.drawNest(this.nest);

    if (s === "clean") {
      // A wave of water sweeping left to right, clearing everything behind it.
      const front = Math.floor((st / 1.6) * (COLS + 6)) - 3;
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < Math.min(COLS, front); x++) this.set(x, y, 0);
      for (let y = 0; y < ROWS; y++) {
        const wave = front + Math.round(Math.sin(y * 0.9 + st * 12) * 1.2);
        this.set(wave, y);
        this.set(wave - 2, y, (y + Math.floor(st * 10)) % 3 === 0 ? 1 : 0);
      }
    }
  }

  // The icon patterns, as 0/1 per dot, for the screen to light by `icons`.
  static iconArt() {
    return ICON_ART.map((s) => s.bits);
  }
}
