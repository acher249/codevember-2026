# Day 18: Pendulum

<img src="../videos/18-pendulum.gif" alt="Pendulum" width="384">

[Try it live](https://adamwebsite.com/codevember/18-pendulum/)

A partitioned paint bucket swings over a canvas in a white daylit studio, pouring two colors through neighboring outlets.

## How to play

Press **Start painting** for a repeatable swing, or grab the bucket, pull it back and let it fly. Choose **Color A** and **Color B** for its two compartments. Spin the bucket or canvas either way, and save your painting when you like it. The floor palette sets Color A.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/18-pendulum/>.

### Compare color mixing

The default blue and yellow paints stay separate inside the bucket. Its outlet centers are 20 mm apart, each tilted 3° inward, bringing their wet trails together during an ordinary pour. The colors remain separate in flight and mix only where their paint reaches the same part of the canvas or floor.

Each outlet carries its base color plus lighter and darker ZUV variants as three adjacent filaments, sharing that outlet's paint volume. **Z variation** controls the requested brightness difference; zero gives plain colors. The variants follow ZUV Paint's fixed-hue, chroma-limited construction, backing off the Z shift when needed to retain at least 45% of the base chroma. The selected base colors stay unchanged.

Choose **RGB** or **ZUV artistic** under **Color mixing** to compare the same painting immediately, including paint on the floor. Switching models does not reset the canvas or change the swing, amount of paint, flow, drying, or surface lighting. Save painting exports the selected view. Paint keeps the color it had when it left its bucket, even if that bucket changes color before it lands.

Both color histories are retained. RGB uses volume-weighted linear sRGB; ZUV uses William F. Barnes's artistic ZUV model on encoded sRGB, with `A = (0.2126, 0.7152, 0.0722)` and `tau = 0.5726`. The signed ZUV coordinates are mixed with exactly the same wetness and volume weights as RGB. Only the displayed color is gamut-mapped: when needed, chroma is reduced at fixed Z and hue before conversion to linear sRGB for lighting. Stored mixtures remain floating point and are never clipped or reduced to 8-bit colors between flow steps. This is an artistic color model, not a spectral pigment simulation.

The selected CSS color is decoded from sRGB once for RGB paint; the previous extra `convertSRGBToLinear()` after `Color.set(string)` decoded it twice. Both comparison views now start with the same selected color. The ZUV path uses encoded sRGB coordinates internally and decodes only for rendering.

This comparison adds two signed color buffers (32 bytes per grid column including GPU alignment) and weighted vector operations to deposition/flow. Trigonometry and gamut mapping run when displaying ZUV and once per color/variation change to prepare divided-bucket paint; neither is added to the flow simulation. Prepared variants are real in-gamut input colors, retained at full precision. Display mapping of later mixtures never feeds back into the stored paint.

### Verification

`npm run test:pendulum-zuv` checks the CPU transforms against independent ZUV core fixtures, reversibility, neutral colors, multiway mixing, gamut projection, and the sRGB transfer function. It also checks the brush variants against ZUV Paint, repeatable launches, stable filament identities, unchanged total flow, paint colors retained in flight, and close wet-trail contact. `npm run typecheck` checks the TypeScript integration.

For actual GPU checks, temporarily create `app/pendulum-mixing-test/page.tsx` containing:

```tsx
export { default } from "../../18-pendulum/mixing-test-page";
```

Start the development server, open `/pendulum-mixing-test/`, and press **Run GPU tests**. The checks read back real GPU buffers, compare deposition and flow against independent scalar references, verify signed storage and gamut limits, and confirm that switching the display leaves both histories unchanged. Simultaneous blue/yellow landings are checked against a 1:3 volume reference, reversed source order, and the original single-color path. Back-to-back dispatches reuse the same source-array slots without awaiting, verifying that overflow batches retain their own colors and volume. The page also shows GPU-rendered blue-to-yellow comparison strips. Remove the temporary route after testing; the test page is not part of the published site.

The deposition reference deliberately retains an existing shader sequencing detail: its wetness numerator reads the height after the cell write, while the denominator uses the cached total. This contribution leaves that behavior unchanged, so color models are compared under the same simulation.

## Technical overview

### The swing

- The bucket is a spherical pendulum stepped 240 times a second, its slowly turning, decaying ellipse drawing the spirograph.
- Grab and throw it up to 55 degrees out; a dotted line previews the next six seconds by running the pendulum ahead.
- Its two close, inward-facing outlets turn together as the bucket spins; the canvas can turn too. Paint stops before it heaps.

### The paint

- Paint leaves each outlet by Torricelli's law as free-falling parcels, drawn as three filaments that thin and break into beads. The filaments divide the outlet's existing flow equally.
- A GPU thin film on up to 640 by 640 columns flows past its yield stress and dries in seconds, so later lines lie crisply over earlier ones.
- Paint that misses the canvas lands on a second, coarser film over five metres of concrete floor.

### Rendering

- The canvas mesh is displaced straight from the sim, glossy while wet and satin when dry.
- A white loft with a cyclorama and softboxes; walls are built round real window openings, so the sun draws the bars on the floor.
- Save painting draws the canvas from overhead at 2048 pixels, its pipelines prebuilt and pixels converted between frames, so nothing stalls.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
