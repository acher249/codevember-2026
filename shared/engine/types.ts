import type { ComponentType } from "react";

export type RangeSetting = {
  type: "range";
  label: string;
  min: number;
  max: number;
  // A lower ceiling on a narrow screen, for settings that cost more than a phone can give.
  phoneMax?: number;
  step?: number;
  value: number;
  // Shows a small Reset beside the label whenever the slider is away from this value, and sets it back.
  reset?: number;
};

export type ToggleSetting = {
  type: "toggle";
  label: string;
  value: boolean;
  // A choice between two named states, shown either side of the switch instead of the label: off, then on.
  sides?: [string, string];
  // On a phone, a round button with this icon instead of a pill with words: pressing it turns the setting on, and the
  // button fades away while it is on, or while the setting named by showWhile is false.
  icon?: "pause";
  showWhile?: string;
};

export type ChoiceSetting = {
  type: "choice";
  label: string;
  options: { value: string; label: string; swatch?: string[]; short?: string }[];
  value: string;
  // What pressing the option already chosen goes back to. Without this, it does nothing.
  pressAgain?: string;
};

export type ActionSetting = {
  type: "action";
  label: string;
};

// Any colour, picked off a gradient pad (hue across, pale to vivid to dark down), with a row of preset chips. The value
// is a hex string.
export type ColourSetting = {
  type: "colour";
  label: string;
  value: string;
  presets?: { label: string; colour: string }[];
};

// A control can belong to one choice of another setting, and only shows while that is chosen; or with `not`, shows
// for every choice but that one.
export type OverviewSection = { title: string; points: string[] };

// short: a label for the phone dock, where space is tight.
export type Setting = (RangeSetting | ToggleSetting | ChoiceSetting | ActionSetting | ColourSetting) & {
  when?: { setting: string; is: string | boolean } | { setting: string; not: string | boolean };
  short?: string;
  // State the scene publishes for the HUD to follow, never drawn as a control.
  hidden?: boolean;
};
export type SettingsSchema = Record<string, Setting>;
export type SettingValue = number | boolean | string;

export type QualityTier = "low" | "medium" | "high";

// How a day wants the shared render stack tuned. Everything is optional.
// Where the renderer is in bringing a scene up: not drawing yet, drawing behind the loader, or on show.
export type RenderPhase = "hold" | "warm" | "live";

export type Look = {
  background: string;
  exposure: number;
  bloom: number;
  bloomThreshold: number;
  // Strength of the screen-space bounce light. Only the high tier runs it.
  gi: number;
  // How far the bounce light reaches, in world units (8 when not set): a tabletop scene needs far less.
  giRadius?: number;
  // Ambient occlusion strength, and its reach in world units.
  ao: number;
  aoRadius: number;
  aoReach: number;
  // Volumetric light through the Haze volume, added on top of the scene.
  haze: number;
  vignette: number;
  grain: number;
};

// How far a day's camera may go: a sphere, and optionally a level it stays above. `endless` is for a world that repeats
// every `period` units across the ground: there is no sphere then, only the floor and a `ceiling`, and the camera is carried
// back a whole period whenever it strays more than one from the middle, which keeps numbers small however far it goes.
export type Extents = { centre: [number, number, number]; radius: number; floor?: number; color?: string; endless?: { period: number; ceiling: number } };

// air is how thick the air gets, up to a limit. By default it thickens from the lens at a fixed rate. airRate changes that rate,
// and airBehindFocus starts it that far in front of the focus, so that depth reads the same at any zoom. sharpSky leaves
// whatever wrote no depth, such as a star dome, out of both the air and the blur.
// A lens blur by where things fall on screen rather than how far away they are, for what writes no depth, such as
// Gaussian splats: none left of `from` (0 to 1 across the screen), full at `to`, `amount` setting how soft. `left` adds
// some at the left edge too, full at `to` and gone by `from`, at `strength` of the right's.
export type SideBlur = { from: number; to: number; amount: number; left?: { from: number; to: number; strength: number } };

export type DepthOfField = { range: number; air?: number; airRate?: number; airBehindFocus?: number; sharpSky?: boolean };

// Keeps the camera near where it starts: `turn` degrees of orbit each way, and `move` units of travel each way for the point
// it looks at and for its distance from that point. Either can instead give each way its own amount. Travel is measured
// along the world's axes: left and right along x, down and up along y, and nearer and further as the distance.
type EachWay<T extends string> = number | Record<T, number>;
// `ahead` lets flying forward carry the point looked at that far on, past the subject, and `closest` keeps the camera that
// far, across the ground, from where that point began, so it can come close to the subject but never into it.
export type CameraLimits = { turn: EachWay<"left" | "right" | "up" | "down">; move: EachWay<"left" | "right" | "down" | "up" | "nearer" | "further">; ahead?: number; closest?: number };

export type DayDefinition = {
  // `phone`, if given, is where the camera starts instead on a narrow screen, where a desktop's framing would leave the
  // subject off to one side.
  camera: { position: [number, number, number]; target: [number, number, number]; fov?: number; sprintFov?: number; limits?: CameraLimits; phone?: { position: [number, number, number]; target: [number, number, number]; fov?: number } };
  look?: Partial<Look>;
  // A world to move about in rather than a thing to turn over: Shift flies or runs flat out, widening the view a fifth
  // and streaking the edges of the frame. It also hovers, as below.
  explore?: boolean;
  // The eye always hangs a little in the air and drifts, laid over whatever the controls do. On for an explorable world.
  hover?: boolean;
  extents?: Extents;
  // The settings that get their own pills on a phone, down the right of the screen. The panel holds the rest.
  phonePills?: string[];
  // The settings laid out in a dock along the bottom of a phone, full controls rather than pills: sliders side by side,
  // choices as a row of chips. For a day played with its settings, not only tuned.
  phoneDock?: string[];
  // Pills that ride on the dock's top right corner, just above it, within a thumb's reach.
  phoneDockPills?: string[];
  // Auto will not go below this. For a day whose whole point is lost on a lower tier.
  autoFloor?: QualityTier;
  // The most pixels per CSS pixel the day draws at, for scenes too heavy to shade at a retina screen's full density.
  maxDpr?: number;
  // Auto starts no higher than this, on a day so heavy that stepping down later would stall it with a rebuild.
  autoStart?: QualityTier;
  // Passes a scene has no use for, so it need not pay for them. Both default to on.
  // halfBounce traces the bounce light at half size, for a day that needs the time more than the detail.
  // toneMapping "none": the image as rendered, unmapped, for a scene drawn straight to the screen at times that must match it.
  // temporal false: edges smoothed within each frame (FXAA) rather than across frames, and only on a screen of under 1.75 CSS
  // pixels to the device pixel, where the edges need it; for a scene that must look the same from its first frame.
  // occlusion false: no shading in creases, for a scene that has none to show.
  passes?: { bounce?: boolean; halfBounce?: boolean; haze?: boolean; overlay?: boolean; depthOfField?: DepthOfField; sideBlur?: SideBlur; chromatic?: number; rush?: boolean; toneMapping?: "none"; temporal?: false; occlusion?: false };
  settings?: SettingsSchema;
  hint?: string;
  // How the scene is made, in a couple of sentences. Shown under the wordmark on desktop.
  notes?: string;
  // How it is built, in more depth: a few short sections behind a collapsed panel under the notes, on desktop.
  overview?: OverviewSection[];
  // Shown in the middle of the screen until the day calls dismissPrompt.
  // high: on a desktop, set well up the screen, clear of a subject that sits in the middle; low: under it, smaller.
  prompt?: { title: string; detail?: string; high?: boolean; low?: boolean };
  // Anything of the day's own to show over the scene, as ordinary page content.
  Overlay?: ComponentType;
  Scene: ComponentType;
};

export const DEFAULT_LOOK: Look = {
  background: "#0a0b0e",
  exposure: 1,
  bloom: 0.25,
  bloomThreshold: 0.9,
  gi: 6,
  ao: 1,
  aoRadius: 0.5,
  aoReach: 200,
  haze: 1,
  vignette: 0.3,
  grain: 0.025
};
