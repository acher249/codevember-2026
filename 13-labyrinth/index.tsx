"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { useSetting, useSettingsStore } from "../shared/engine/settings";
import { sound, useMusic } from "../shared/engine/sound";
import type { DayDefinition } from "../shared/engine/types";
import { Walk } from "../shared/engine/walk";
import Coins from "./coins";
import { game } from "./game";
import { Hedge, hedgesUp, VIEW } from "./hedge";
import { FOOTSTEPS, useAmbience } from "./sounds";
import { STYLES, type Style, useStyle } from "./styles";
import { Play } from "./play";
import { hedgeSolids, PERIOD } from "./walk";
import { STUDIES, type Study } from "./warp";

// The sound of the world changing shape.
const SHIFT = "/assets/13-labyrinth/world-change.mp3";

function Scene() {
  useMusic("/codevember/music/the-ultimate-betrayal.mp3", 0.32);
  const walk = useSetting<boolean>("walk");
  const study = useSetting<Study>("study");
  // As soon as the hedges have all risen, the flat maze folds up into walls all round, unless another world has
  // been chosen already.
  const store = useSettingsStore();
  const folded = useRef(false);
  // A sweep of sound with every change of world, and once at the start a second before the maze folds up.
  useEffect(() => sound.preload(SHIFT), []);
  const heard = useRef(study);
  const quietly = useRef(false);
  useEffect(() => {
    if (study === heard.current) return;
    heard.current = study;
    if (quietly.current) quietly.current = false;
    else sound.sample(SHIFT, 0.7);
  }, [study]);
  useFrame(() => {
    if (folded.current || hedgesUp.at === Infinity) return;
    folded.current = true;
    if (store.get("study") !== "flat") return;
    sound.sample(SHIFT, 0.7);
    window.setTimeout(() => {
      if (store.get("study") !== "flat") return;
      quietly.current = true;
      store.set("study", "fold");
    }, 1000);
  });
  const style = useSetting<Style>("style");
  useAmbience(style);
  // Game mode: coins all about the maze to collect, and the count and its milestones over the scene.
  const playing = useSetting<boolean>("game");
  useEffect(() => game.setOn(playing), [playing]);
  // The game is played on foot: turning it on walks you down into the maze, and taking off to fly ends it.
  const was = useRef({ walk, playing });
  useEffect(() => {
    if (playing && !was.current.playing && !walk) store.set("walk", true);
    else if (!walk && was.current.walk && playing) store.set("game", false);
    was.current = { walk, playing };
  }, [walk, playing, store]);
  useEffect(() => () => game.setOn(false), []);
  return (
    <>
      <Hedge study={study} />
      <Walk on={walk} solids={hedgeSolids} steps={FOOTSTEPS[style]} fov={85} />
      <Styled />
      {playing ? <Coins /> : null}
    </>
  );
}

// After the hedge, so that its look goes on over the natural one.
function Styled() {
  useStyle(useSetting<Style>("style"));
  return null;
}

const labyrinth: DayDefinition = {
  camera: { position: VIEW.position, target: VIEW.target, fov: VIEW.fov ?? 40 },
  explore: true,
  // The maze repeats every period, so there is no edge to it: fly any way for as long as you like.
  extents: { centre: [0, 2, 0], radius: 60, floor: 0.6, endless: { period: PERIOD, ceiling: 60 } },
  // The low tier drops what grows on the hedges, so auto stops a step above it.
  autoFloor: "medium",
  // Every pixel carries leaves, gravel, mist and bounce light: drawn at one pixel per CSS pixel it holds 60 on a retina
  // screen, and the temporal filter keeps the edges clean.
  maxDpr: 1,
  passes: { bounce: true, halfBounce: true, haze: true, overlay: true, depthOfField: { range: 18, air: 0.5 } },
  // Black: the overlay pass clears to the background and is added over the frame, so any colour here would veil it.
  look: { background: "#000000", gi: 1, ao: 1, exposure: 1, bloom: 0.2, bloomThreshold: 0.85, vignette: 0.5, grain: 0.015 },
  settings: {
    walk: { type: "toggle", label: "Walk", value: false, sides: ["Fly", "Walk"] },
    // The world bent around the eye: up into a ring overhead, folded up into walls all round, or twisted over like a
    // ribbon.
    study: { type: "choice", label: "World", value: "flat", options: STUDIES },
    // The same maze drawn in another manner: nothing in it moves any differently.
    style: { type: "choice", label: "Style", value: "natural", options: STYLES },
    game: { type: "toggle", label: "Game mode", value: false }
  },
  phonePills: ["walk", "study", "style", "game"],
  Overlay: Play,
  hint: "Drag to look around, WASD to fly. Walk takes you down into the maze, Space to jump over the hedges; on a phone, hold still to walk.",
  notes: "A hedge maze without end that never stops rebuilding itself.",
  overview: [
    {
      title: "The maze",
      points: [
        "A perfect maze, one with exactly one way between any two cells, generated on a 40 by 40 torus and laid over the ground again and again, so it reaches past the mist in every direction and has no edge to run into. Flying further than one copy carries the camera, and everything round it, back by one, so it can go on for ever.",
        "It rewrites itself one loop at a time. Taking a wall out of a perfect maze always makes exactly one loop, and putting back any other wall on that loop makes a perfect maze again, so the maze is never broken, only ever different. Walls sink into the earth and others grow back out of it every few seconds, near where you are looking.",
        "How far up each wall stands is kept every frame: the hedges are drawn from it, walking bumps into it, and the coins and rabbits read it to know where a hedge stands."
      ]
    },
    {
      title: "Hedges and what grows on them",
      points: [
        "Every wall and post is one instance of a box, close up finely made, with a TSL material that lays clipped leaves over its faces from noise, lumps and thin patches of its own, and lifts the surface along them. Far off, where a leaf is smaller than a pixel, only the colour the leaves make is kept.",
        "Near the camera each hedge is dressed with cards drawn on the same instances: loose leaves standing out of it, new shoots, ivy, bindweed, bramble and clematis climbing over it, grass and fallen leaves at its foot, and stones along its edge. One material cuts every kind of card to its own shape; each hedge rolls its own dice for which pieces show, so no two are alike. Only hedges in or near the view are dressed.",
        "Pebbles and dropped leaves lie on the gravel in a grid that repeats with the maze, so nothing on the ground seems to move as you do. Fireflies drift low along the paths, swifts wheel overhead in flocks, and white rabbits hop from cell to cell wherever no hedge stands between."
      ]
    },
    {
      title: "Bent worlds",
      points: [
        "Every surface is lit, shadowed and misted where it really lies, on flat ground, and only drawn somewhere else: at the last step before the screen each point is carried, relative to the eye, to where the chosen world puts it. So the bend goes wherever the camera goes, without end, and shadows stay in the flat world they are looked up in.",
        "Ring runs the maze round the inside of a hoop eight copies round, so it carries straight on overhead. Fold turns it up a hinge into walls all round that lean in at the top. Twist turns it over about the line of sight, half a turn every 70 metres, like a ribbon. Motion vectors carry the bend too, so the temporal anti-aliasing holds through it."
      ]
    },
    {
      title: "Light and air",
      points: [
        "A low evening sun with shadow maps, bounce light and occlusion traced in screen space, and a volume of mist lying thickest in the paths, gathered in its own pass and blurred over the frame. Depth of field softens the far maze and bloom takes the fireflies.",
        "Tron draws the same maze, rewriting itself the same way, in another manner: lines of light along every edge, reflections traced along the maze's own walls, chips, traces, panels, cables and masts on the hedges, and craft and packets of light going round in the sky."
      ]
    },
    {
      title: "Walking, flying and the game",
      points: [
        "Fly over it, or walk down into it: walking collides with the hedges as they stand that frame, with a jump over them and a damped rise back out. Sprinting widens the view and streaks the edges of the frame, and the camera always hovers a little, flying or walking.",
        "Game mode lays coins down every path and along every hedge top, a little over half a metre apart, and the rabbits run from you and can be caught for more. The count is kept in the browser; every tenth and hundredth coin brings up a card from the foot of the screen.",
        "Every sound is synthesised in Web Audio: an evening of wind, crickets and birdsong with gravel underfoot, or a hum, shimmer and relay clicks over the ringing grid in Tron, and a coin's ding that climbs the scale while they keep coming."
      ]
    }
  ],
  Scene
};

export default labyrinth;
