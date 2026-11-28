import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three/webgpu";
import { loadRetried } from "../../shared/engine/retry";

// The forest's scans (all CC0, Poly Haven; see public/assets/27-burrow/CREDITS.txt): bark for the trees, moss, a fallen trunk and a broken branch, mossy boulders, and a leafy woodland plant.

const ROOT = "/assets/27-burrow";

async function load(name: string, colour: boolean) {
  const tex = await loadRetried(new THREE.TextureLoader(), `${ROOT}/${name}`);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// A glTF scan's pieces as plain geometry (position, normal, uv), each set down on y = 0 and centred, with its maps.
export type Scan = { pieces: THREE.BufferGeometry[]; diffuse: THREE.Texture; normal: THREE.Texture };
async function scan(name: string) {
  const [gltf, diffuse, normal] = await Promise.all([
    loadRetried(new GLTFLoader(), `${ROOT}/${name}/${name}.gltf`),
    load(`${name}/textures/${name}_diff_1k.jpg`, true),
    load(`${name}/textures/${name}_nor_gl_1k.jpg`, false)
  ]);
  diffuse.flipY = normal.flipY = false;
  const pieces: THREE.BufferGeometry[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = new THREE.BufferGeometry();
    for (const key of ["position", "normal", "uv"]) g.setAttribute(key, mesh.geometry.getAttribute(key));
    g.setIndex(mesh.geometry.getIndex());
    g.computeBoundingBox();
    const box = g.boundingBox!;
    g.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    pieces.push(g);
  });
  return { pieces, diffuse, normal } as Scan;
}

// `stone`: the rock's own scan of broken rock face (rock.ts `broken`), shared rather than loaded twice; loaded here only
// when it is not given.
export async function loadForest(shared?: THREE.Texture) {
  const [bark, barkNormal, barkRough, moss, stone, log, branch, boulders, shrub] = await Promise.all([
    load("bark_brown_02_diff_2k.jpg", true),
    load("bark_brown_02_nor_gl_1k.jpg", false),
    load("bark_brown_02_rough_1k.jpg", false),
    load("moss_diff_1k.jpg", true),
    shared ? Promise.resolve(shared) : load("rock_face_diff_2k.jpg", true),
    scan("dead_tree_trunk_02"),
    scan("dead_tree_trunk"),
    scan("rock_moss_set_02"),
    scan("shrub_03")
  ]);
  return { bark, barkNormal, barkRough, moss, stone, log, branch, boulders, shrub };
}
export type ForestTextures = Awaited<ReturnType<typeof loadForest>>;
