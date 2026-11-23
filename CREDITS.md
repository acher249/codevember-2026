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
| [MediaPipe](https://github.com/google-ai-edge/mediapipe) (`@mediapipe/tasks-vision` and the Hand Landmarker model, for Bolt's IRL Hands) | Apache-2.0 |

`npm run build` writes the full license text of everything in the built site to `public/THIRD_PARTY_NOTICES.txt`.

## Fonts

[Darker Grotesque](https://github.com/bettergui/DarkerGrotesque) and [Karla](https://github.com/googlefonts/karla), both under the SIL Open Font License 1.1. The license texts are in [`licenses/`](licenses).

The calendar's 3D title is built from Darker Grotesque's own outlines, converted to three.js's typeface format (`shared/hub/spaces/codevember-type.json`), under the same license.

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
| [Bark Brown 02](https://polyhaven.com/a/bark_brown_02), on the twigs in Tension and Cocoon and the trees in Spore | Rob Tuytel |
| [Dry Decay Leaves](https://polyhaven.com/a/dry_decay_leaves), the forest floor in Spore | Amal Kumar |
| [Forest Leaves 02](https://polyhaven.com/a/forest_leaves_02) | Rob Tuytel |
| [Jolcham Oak Bark 01](https://polyhaven.com/a/jolcham_oak_bark_01) | Charlotte Baglioni |
| [Dead Tree Trunk](https://polyhaven.com/a/dead_tree_trunk) | Rob Tuytel |
| [Dead Tree Trunk 02](https://polyhaven.com/a/dead_tree_trunk_02) | Jenelle van Heerden, Rico Cilliers |
| [Dry Branches Medium 01](https://polyhaven.com/a/dry_branches_medium_01) | Rico Cilliers |

From [ambientCG](https://ambientcg.com): [Moss 003](https://ambientcg.com/view?id=Moss003).

The rusted post and the beach in Rust are my own: the post captured with [Polycam](https://poly.cam), the beach made from my own photograph.

## Splats

Rust is drawn as 3D Gaussian splats, after Kerbl, Kopanas, Leimkühler and Drettakis, *3D Gaussian Splatting for Real-Time Radiance Field Rendering* (SIGGRAPH 2023). They are stored as [SPZ](https://github.com/nianticlabs/spz), Niantic's compressed splat format (MIT), and loaded and drawn by three.js's own SPZLoader and GaussianSplat.

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
- **Vortex lattice and Biot–Savart induction**, for Feather's airflow: the standard method of aerodynamics texts such as Katz and Plotkin, *Low-Speed Aerodynamics* (2001)
- **Perlin–Worley noise, Beer–Lambert and the Henyey–Greenstein phase function**, for Feather's clouds: after Schneider and Vos, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn" (SIGGRAPH 2015)
- **Hash without Sine**, for Labyrinth's noise: [Dave Hoskins](https://www.shadertoy.com/view/4djSRW)
- **Tileable water caustic**, for Kelp's caustics and its surface from below: [Dave Hoskins](https://www.shadertoy.com/view/MdlXz8) (MIT)
- **meshoptimizer**, which simplified Kelp's scanned rocks and Labyrinth's rabbit beforehand: [Arseny Kapoulkine](https://github.com/zeux/meshoptimizer) (MIT)
- **Bump mapping without tangents**, for the veins in Labyrinth's leaves: Morten Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU" (2010)
- **Mathematical morphology** (erosion and dilation by a structuring element), for Erosion: Georges Matheron and Jean Serra, École des Mines de Paris (1964 onward)

## Bird wings

The research Feather is built on, cited in its technical overview.

- Wing bone proportions: Hayward et al., glaucous-winged gull wing bones (*Journal of Morphology*, 2009)
- Elbow and wrist linkage: Vazquez (*Zoomorphology*, 1994)
- Feather tracts: Proctor and Lynch, *Manual of Ornithology* (1993)
- The wingbeat: Tobalske and Dial (*Journal of Experimental Biology*, 1996)
- Gull wingtip patterns: [gull-research.org](https://www.gull-research.org/)

## Butterfly wings

The wings in Cocoon are cut from specimen photographs (background removed, fore and hind wings split, hidden parts filled) and shared under their sources' licences; see [public/assets/20-cocoon/CREDITS.txt](public/assets/20-cocoon/CREDITS.txt).

| Species | Photograph | Licence |
| --- | --- | --- |
| Blue Morpho (*Morpho peleides*), upper and under sides | [Bernard Dupont](https://commons.wikimedia.org/wiki/File:Blue_Morpho_(Morpho_peleides)_(8419468465).jpg), [underside](https://commons.wikimedia.org/wiki/File:Blue_Morpho_(Morpho_peleides)_underside_(8420566556).jpg) | CC BY-SA 2.0 |
| Monarch (*Danaus plexippus*), upper and under sides | [Didier Descouens / MHNT](https://commons.wikimedia.org/wiki/File:Danaus_plexippus_MHNT_dos.jpg), [underside](https://commons.wikimedia.org/wiki/File:Danaus_plexippus_MHNT_ventre.jpg) | CC BY-SA 4.0 |
| Glasswing (*Greta oto*) | Specimen CAM008460, Cambridge butterfly wing collection: Montejo-Kovacevich, Jiggins, Warren and Wiltshire ([Zenodo](https://zenodo.org/records/2684906)); earlier tile from [NSG group, Lund](https://commons.wikimedia.org/wiki/File:NW70-9_Greta_oto_(3429977042).jpg) (CC0) | CC BY 4.0 |
| Paper Kite (*Idea leuconoe*) | [Bernard Dupont](https://commons.wikimedia.org/wiki/File:Wood_Nymph_(Idea_leuconoe_obscura)_(8430453568).jpg) | CC BY-SA 2.0 |

The sounds and music in Cocoon are not in this repo.

## Caustics

The light in Caustic is drawn as a mesh, one ray per vertex, after [Evan Wallace](https://medium.com/@evanwallace/rendering-realtime-caustics-in-webgl-2a99a29a0b2c)'s WebGL Water. The glass Suzannes are traced through maps of their near and far sides drawn from the sun, in the spirit of Chris Wyman, *An Approximate Image-Space Approach for Interactive Refraction* (2005).

Suzanne, Blender's monkey, comes from the [three.js examples](https://github.com/mrdoob/three.js/tree/dev/examples/models/json) (MIT) and is the [Blender Foundation](https://www.blender.org)'s. Their resting poses were found by dropping her in [Rapier](https://rapier.rs).

## Star data

The constellation figures in Orrery come from [d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn, under the BSD 3-Clause license, included in full at [06-orrery/d3-celestial-LICENSE.txt](06-orrery/d3-celestial-LICENSE.txt).

## Ocean

The waves in Hollow, and the sea in Rust, are ported to WebGPU from [Ultra Water](https://github.com/Humpalumps/Ultra-Water) by [Humpalumps](https://github.com/Humpalumps), under the MIT license, included in full at [07-hollow/ultra-water-LICENSE.txt](07-hollow/ultra-water-LICENSE.txt). Thank you for sharing it.

The method behind it: Jerry Tessendorf, *Simulating Ocean Water* (2001), the JONSWAP wave spectrum, from Hasselmann et al. (1973), and the Stockham FFT. The peach's fine surface detail uses bump mapping after Morten Mikkelsen, *Bump Mapping Unparametrized Surfaces on the GPU* (2010).

## Sea floor

The rocks and sand under the water in Hollow are scans from [Poly Haven](https://polyhaven.com), all CC0, so no credit is required, but it is due.

| Asset | By |
| --- | --- |
| [Rock Moss Set 02](https://polyhaven.com/a/rock_moss_set_02) | Kless Gyzen |
| [Rock 09](https://polyhaven.com/a/rock_09) | Jenelle van Heerden |
| [Namaqualand Boulder 03](https://polyhaven.com/a/namaqualand_boulder_03) | Jenelle van Heerden, Dario Barresi |
| [Sand 01](https://polyhaven.com/a/sand_01) | Rob Tuytel |
| [Gravelly Sand](https://polyhaven.com/a/gravelly_sand) | Dario Barresi |

The fish is the [Barramundi Fish](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/BarramundiFish) by Microsoft, also CC0, from the Khronos glTF Sample Assets.

## Kelp

The rocks, reef and sand on the floor of Kelp are scans from [Poly Haven](https://polyhaven.com), all CC0, so no credit is required, but it is due. With those listed under Sea floor above (Rock Moss Set 02, Rock 09, Namaqualand Boulder 03 and Sand 01):

| Asset | By |
| --- | --- |
| [Rock 07](https://polyhaven.com/a/rock_07) | Jenelle van Heerden |
| [Coast Sand Rocks 02](https://polyhaven.com/a/coast_sand_rocks_02) | Rob Tuytel |
| [Low Tide Rocks](https://polyhaven.com/a/low_tide_rocks) | Dimitrios Savva |

## Pendulum

The worn concrete under the studio floor's paint in Pendulum is a scan from [Poly Haven](https://polyhaven.com), CC0, so no credit is required, but it is due.

| Asset | By |
| --- | --- |
| [Concrete Floor Worn 001](https://polyhaven.com/a/concrete_floor_worn_001) | Dimitrios Savva and Rico Cilliers |

## Meshy

The rabbits and the leaves among the vines in Labyrinth are [Meshy](https://www.meshy.ai) models made for it, cut right down for the scene.

## Bolt

The rooms round Bolt's plasma globe are HDRIs from [Poly Haven](https://polyhaven.com), all CC0, so no credit is required, but it is due. They ship as compact `.room` files packed from the 1k `.hdr` by `21-bolt/plasma/pack-room.mjs`.

| Asset | By |
| --- | --- |
| [Warm Bar](https://polyhaven.com/a/warm_bar) | Greg Zaal (photography), Jarod Guest (processing) |
| [Christmas Photo Studio 01](https://polyhaven.com/a/christmas_photo_studio_01) | Sergej Majboroda |
| [Studio Small 03](https://polyhaven.com/a/studio_small_03) | Greg Zaal |
| [Dresden Station (Night)](https://polyhaven.com/a/dresden_station_night) | Greg Zaal |

IRL Hands runs Google's [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) on the visitor's own device (Apache-2.0); its model and WebAssembly files are in `public/assets/21-bolt/mediapipe/`.

## Echo

Echo's graphics cards, memory sticks, bubble and hall of mirrors are all made in code. The Dust study (`?v=dust`) samples a head scan into points:

| Asset | By | License |
| --- | --- | --- |
| "Infinite, 3D Head Scan" (`public/assets/22-echo/dust/head.glb`, `head-relief.jpg`), from the three.js examples; hidden inner parts removed and the displacement map scaled to 1024 px | Lee Perry-Smith, [Infinite-Realities](https://www.ir-ltd.net), based on a work at [triplegangers.com](https://www.triplegangers.com) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

## Magma

The counter's marble and the knife block's oak are CC0 textures, so no credit is required, but it is due. Everything else (the pocket and its sleeve, the pizza rolls, the plate, the microwave and the props) is modelled, printed and shaded in code, and its sounds are synthesised.

| Asset | By | License |
| --- | --- | --- |
| [Marble 012](https://ambientcg.com/view?id=Marble012) (`public/assets/23-magma/marble012_*`) | [ambientCG](https://ambientcg.com) | CC0 |
| [Oak Veneer 05](https://polyhaven.com/a/oak_veneer_05) (`public/assets/23-magma/oak_veneer_05_*`) | [Poly Haven](https://polyhaven.com) | CC0 |
