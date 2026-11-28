# Day 27: Burrow

<img src="../videos/27-burrow.gif" alt="Burrow" width="384">

[Try it live](https://adamwebsite.com/codevember/27-burrow/)

A granite cliff in a forest clearing at midday. Walk up and dig in with a pick, light your way with torches, and break into what the rock has hidden.

## How to play

Walk up to the cliff and click its face to dig in (the ground outside won't give); once you're in the rock, dig any way, down too. T or a right click mounts one of your 60 torches. L takes one of 5 ladders: lean it on a wall up to a ledge or an opening, walk into it to climb, right click it to take it back. P raises a camera: hold Shift to line up a shot and click or Space to take it. The rock goes on for ever, and so do the caverns.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/27-burrow/>.

## Technical overview

### Endless rock

- A signed field with no edge: a cliff, its plateau and the ground, sampled at 20 cm in 6.4 m chunks as you come near.
- Workers mesh the nearest chunks by surface nets; every dig is kept as a sparse edit, so tunnels come back as left.
- Caverns come from hashed cells in staggered layers, one every 10–20 m dug any way; a worker dresses each; finds sit in finer cells.

### Underground

- Sky light fades with depth into the rock, and the sun's shadow map follows you so it never shines through stone.
- You carry 60 torches (camps hold spares); the nearest six mounted get real lights, the rest keep flame and glow.
- Cavern glows are summed per vertex; still pools mirror the torches by reflecting the view, with no second render.

### Sound

- Rays through the rock measure the space round you; strikes, drips and torches feed a short and a long reverb.
- Strikes ring hollow as the rock thins over a cavern; each kind opens with its own voice, a river roars through stone.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
