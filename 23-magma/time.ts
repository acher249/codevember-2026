// The scene's own clock, run faster by the Speed slider: the lava, the crumbs and their fires all take their time from
// it, so a burn's delays and lengths keep pace with the flow. Sounds and the microwave keep real time.

export const clock = { speed: 1, now: 0 };
