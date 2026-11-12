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
};

export type ToggleSetting = {
  type: "toggle";
  label: string;
  value: boolean;
  // A choice between two named states, shown either side of the switch instead of the label: off, then on.
  sides?: [string, string];
};

export type ChoiceSetting = {
  type: "choice";
  label: string;
  options: { value: string; label: string; swatch?: string[] }[];
  value: string;
  // What pressing the option already chosen goes back to. Without this, it does nothing.
  pressAgain?: string;
};

export type ActionSetting = {
  type: "action";
  label: string;
};

// A control can belong to one choice of another setting, and only shows while that is chosen.
export type OverviewSection = { title: string; points: string[] };

export type Setting = (RangeSetting | ToggleSetting | ChoiceSetting | ActionSetting) & { when?: { setting: string; is: string | boolean } };
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
  camera: { position: [number, number, number]; target: [number, number, number]; fov?: number; limits?: CameraLimits; phone?: { position: [number, number, number]; target: [number, number, number]; fov?: number } };
  look?: Partial<Look>;
  extents?: Extents;
  // The settings that get their own pills on a phone, down the right of the screen. The panel holds the rest.
  phonePills?: string[];
  // Auto will not go below this. For a day whose whole point is lost on a lower tier.
  autoFloor?: QualityTier;
  // Auto starts no higher than this, on a day so heavy that stepping down later would stall it with a rebuild.
  autoStart?: QualityTier;
  // Passes a scene has no use for, so it need not pay for them. Both default to on.
  passes?: { bounce?: boolean; haze?: boolean; overlay?: boolean; depthOfField?: DepthOfField; sideBlur?: SideBlur; chromatic?: number };
  settings?: SettingsSchema;
  hint?: string;
  // How the scene is made, in a couple of sentences. Shown under the wordmark on desktop.
  notes?: string;
  // How it is built, in more depth: a few short sections behind a collapsed panel under the notes, on desktop.
  overview?: OverviewSection[];
  // Shown in the middle of the screen until the day calls dismissPrompt.
  prompt?: { title: string; detail?: string };
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
