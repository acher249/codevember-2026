# Credits

Codevember stands on a lot of other people's work. Thank you to all of them.

## Libraries

| Library | License |
| --- | --- |
| [three.js](https://threejs.org) | MIT |
| [React Three Fiber](https://github.com/pmndrs/react-three-fiber) | MIT |
| [@react-three/rapier](https://github.com/pmndrs/react-three-rapier) | MIT |
| [Rapier](https://rapier.rs) | Apache-2.0 |
| [Next.js](https://nextjs.org) | MIT |
| [React](https://react.dev) | MIT |
| [Framer Motion](https://motion.dev) | MIT |

`npm run build` writes the full license text of everything in the built site to `public/THIRD_PARTY_NOTICES.txt`.

## Fonts

[Darker Grotesque](https://github.com/bettergui/DarkerGrotesque) and [Karla](https://github.com/googlefonts/karla), both under the SIL Open Font License 1.1. The license texts are in [`licenses/`](licenses).

## Scans

All CC0, so no credit is required, but it is due.

From [Poly Haven](https://polyhaven.com):

| Asset | By |
| --- | --- |
| [Cliff Side](https://polyhaven.com/a/cliff_side) | James Ray Cock, Jenelle van Heerden, Dario Barresi |
| [Rock Face 03](https://polyhaven.com/a/rock_face_03) | Dario Barresi, Rico Cilliers |
| [Mossy Rock](https://polyhaven.com/a/mossy_rock) | Rob Tuytel |
| [Fern 02](https://polyhaven.com/a/fern_02) | Rob Tuytel, Rico Cilliers |
| [Weed Plant 02](https://polyhaven.com/a/weed_plant_02) | Rob Tuytel, Rico Cilliers |
| [Shrub Sorrel 01](https://polyhaven.com/a/shrub_sorrel_01) | Rico Cilliers |
| [Shrub 03](https://polyhaven.com/a/shrub_03) | Rico Cilliers |
| [Rock Moss Set 01](https://polyhaven.com/a/rock_moss_set_01) | Kless Gyzen |

From [ambientCG](https://ambientcg.com): [Moss 003](https://ambientcg.com/view?id=Moss003).

## Techniques

Where these appear, the code says so too.

- **Smooth minimum**, for blending Melt's metal and the deer's body: [Inigo Quilez](https://iquilez.org/articles/smin/)
- **Marching cubes tables**, for skinning the deer: [Paul Bourke](http://paulbourke.net/geometry/polygonise/), through three.js
- **R2 sequence**, for scattering moss fibres: [Martin Roberts](https://extremelearning.com.au/unreasonable-effectiveness-of-quasirandom-sequences/)
- **Position Based Dynamics**, for Tangle's cords: Müller, Heidelberger, Hennix and Ratcliff (2007)
- **Boids**, for the birds: [Craig Reynolds](https://www.red3d.com/cwr/boids/)
- **mulberry32** random numbers: Tommy Ettinger
- **Lehmer random numbers**, with constants from Park and Miller (1988)
- **The `fract(sin(...) * 43758.5453)` hash**, a long-standing shader one-liner whose author isn't known for certain

## Star data

The constellation figures in Orrery come from [d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn, under the BSD 3-Clause license, included in full at [06-orrery/d3-celestial-LICENSE.txt](06-orrery/d3-celestial-LICENSE.txt).
