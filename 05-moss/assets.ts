import { suspend } from "suspend-react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three/webgpu";
import type { QualityTier } from "../shared/engine/types";

// Scanned rock and moss, all CC0: Poly Haven and ambientCG. See public/assets/05-moss/CREDITS.txt.
const ROOT = "/assets/05-moss";

export type Scan = { geometry: THREE.BufferGeometry; size: THREE.Vector3 };
export type Plant = { diffuse: THREE.Texture; normal: THREE.Texture; scans: Scan[] };

export type MossAssets = {
  cliffDiffuse: THREE.Texture;
  cliffNormal: THREE.Texture;
  cliffHeight: THREE.Texture;
  faceDiffuse: THREE.Texture;
  faceNormal: THREE.Texture;
  stoneDiffuse: THREE.Texture;
  mossDiffuse: THREE.Texture;
  mossHeight: THREE.Texture;
  fern: Plant;
  weed: Plant;
  sorrel: Plant;
  shrub: Plant;
  rocks: Plant;
};

async function loadTexture(url: string, colour: boolean) {
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.anisotropy = 12;
  return texture;
}

// Pulled out of the glTF as plain geometry, standing on y = 0 and centred, so that each can be instanced on its own.
async function loadPlant(name: string, resolution: string): Promise<Plant> {
  const [gltf, diffuse, normal] = await Promise.all([
    new GLTFLoader().loadAsync(`${ROOT}/${name}/${name}.gltf`),
    loadTexture(`${ROOT}/${name}/textures/${name}_diff_${resolution}.jpg`, true),
    loadTexture(`${ROOT}/${name}/textures/${name}_nor_gl_${resolution}.jpg`, false)
  ]);
  diffuse.flipY = false;
  normal.flipY = false;
  const scans: Scan[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((child) => {
    const mesh = child as unknown as { isMesh?: boolean; geometry: { getAttribute(n: string): { array: ArrayLike<number> }; index: { array: ArrayLike<number> } } };
    if (!mesh.isMesh) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.geometry.getAttribute("position").array), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(mesh.geometry.getAttribute("normal").array), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(mesh.geometry.getAttribute("uv").array), 2));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.geometry.index.array), 1));
    geometry.computeBoundingBox();
    const box = geometry.boundingBox as THREE.Box3;
    geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    scans.push({ geometry, size: box.getSize(new THREE.Vector3()) });
  });
  return { diffuse, normal, scans };
}

async function loadAll(tier: QualityTier): Promise<MossAssets> {
  const big = tier === "high" ? "4k" : tier === "medium" ? "2k" : "1k";
  const mid = tier === "low" ? "1k" : "2k";
  const plants = tier === "high" ? "2k" : "1k";
  const [cliffDiffuse, cliffNormal, cliffHeight, faceDiffuse, faceNormal, stoneDiffuse, mossDiffuse, mossHeight, fern, weed, sorrel, shrub, rocks] = await Promise.all([
    loadTexture(`${ROOT}/cliff_diff_${big}.jpg`, true),
    loadTexture(`${ROOT}/cliff_nor_${big}.jpg`, false),
    loadTexture(`${ROOT}/cliff_disp_${mid}.jpg`, false),
    loadTexture(`${ROOT}/face_diff_${big}.jpg`, true),
    loadTexture(`${ROOT}/face_nor_${big}.jpg`, false),
    loadTexture(`${ROOT}/stone_diff_${big}.jpg`, true),
    loadTexture(`${ROOT}/moss_diff_${big}.jpg`, true),
    loadTexture(`${ROOT}/moss_disp_${big}.jpg`, false),
    loadPlant("fern_02", plants),
    loadPlant("weed_plant_02", plants),
    loadPlant("shrub_sorrel_01", plants),
    loadPlant("shrub_03", plants),
    loadPlant("rock_moss_set_01", "2k")
  ]);
  return { cliffDiffuse, cliffNormal, cliffHeight, faceDiffuse, faceNormal, stoneDiffuse, mossDiffuse, mossHeight, fern, weed, sorrel, shrub, rocks };
}

export const useMossAssets = (tier: QualityTier) => suspend(() => loadAll(tier), ["codevember-moss", tier]);
