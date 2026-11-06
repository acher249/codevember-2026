import type { ComponentType } from "react";

export type RangeSetting = {
  type: "range";
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
};

export type ToggleSetting = {
  type: "toggle";
  label: string;
  value: boolean;
};

export type ChoiceSetting = {
  type: "choice";
  label: string;
  options: { value: string; label: string; swatch?: string[] }[];
  value: string;
};

export type ActionSetting = {
  type: "action";
  label: string;
};

export type Setting = RangeSetting | ToggleSetting | ChoiceSetting | ActionSetting;
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

// How far a day's camera may go: a sphere, and optionally a level it stays above.
export type Extents = { centre: [number, number, number]; radius: number; floor?: number; color?: string };

export type DayDefinition = {
  camera: { position: [number, number, number]; target: [number, number, number]; fov?: number };
  look?: Partial<Look>;
  extents?: Extents;
  // Auto will not go below this. For a day whose whole point is lost on a lower tier.
  autoFloor?: QualityTier;
  // Auto starts no higher than this, on a day so heavy that stepping down later would stall it with a rebuild.
  autoStart?: QualityTier;
  // Passes a scene has no use for, so it need not pay for them. Both default to on.
  passes?: { bounce?: boolean; haze?: boolean; overlay?: boolean; depthOfField?: { range: number; air?: number } };
  settings?: SettingsSchema;
  hint?: string;
  // How the scene is made, in a couple of sentences. Shown under the wordmark on desktop.
  notes?: string;
  // Shown in the middle of the screen until the day calls dismissPrompt.
  prompt?: { title: string; detail?: string };
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
