"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, type RefObject } from "react";
import * as THREE from "three/webgpu";
import {
  add,
  unpackRGBToNormal,
  diffuseColor,
  packNormalToRGB,
  dot,
  exp,
  float,
  fract,
  length,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  sample,
  screenUV,
  sin,
  smoothstep,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
  velocity
} from "three/tsl";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { chromaticAberration } from "three/addons/tsl/display/ChromaticAberrationNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";
import { ssgi } from "three/addons/tsl/display/SSGINode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import type { Look, QualityTier, RenderPhase, DepthOfField, SideBlur } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model swizzles or MRT lookups. */

// Haze volumes draw only into the quarter-res volumetric pass, on this layer.
export const HAZE_LAYER = 10;

// How far away the lens is focused. A day that asks for depth of field keeps this up to date.
export const focusDistance = uniform(12);
export const focusBlur = uniform(1);
export const airTint = uniform(new THREE.Color("#d8c8b4"));
export const airAmount = uniform(1);

// Fine, fast things such as rain draw into their own pass, added after the temporal blend. Inside the scene pass
// they would write their motion into the buffer that the blend trusts, and everything behind them would shimmer.
export const OVERLAY_LAYER = 11;

export const overlayLink = {
  depth: null as any,
  listeners: new Set<(depth: any) => void>(),
  listen(listener: (depth: any) => void) {
    this.listeners.add(listener);
    if (this.depth) listener(this.depth);
    return () => {
      this.listeners.delete(listener);
    };
  },
  setDepth(depth: any) {
    this.depth = depth;
    for (const listener of this.listeners) listener(depth);
  }
};

// Haze materials stop light at solid objects by reading the scene depth. The stack and the haze
// mount in either order (a day loads after the stack exists), so both sides go through here.
export const hazeLink = {
  depth: null as any,
  materials: new Set<any>(),
  add(material: any) {
    this.materials.add(material);
    if (this.depth) material.depthNode = this.depth.sample(screenUV);
  },
  remove(material: any) {
    this.materials.delete(material);
  },
  setDepth(depth: any) {
    this.depth = depth;
    for (const material of this.materials) {
      material.depthNode = depth.sample(screenUV);
      material.needsUpdate = true;
    }
  }
};

type PostProps = {
  look: Look;
  quality: QualityTier;
  hasHaze: boolean;
  // Screen-space bounce light. Without it the high tier falls back to plain ambient occlusion.
  bounce?: boolean;
  overlay?: boolean;
  depthOfField?: DepthOfField;
  sideBlur?: SideBlur;
  // How far the colours split at the edge of the frame. Nothing on the low tier.
  chromatic?: number;
  phase: RefObject<RenderPhase>;
};

// The shared render stack. Tiers trade cost, never the overall look:
//   high    SSGI (bounce + AO), haze, bloom, TRAA
//   medium  GTAO, haze, bloom, TRAA
//   low     bloom and FXAA, for phones and slow machines
export function Post({ look, quality, hasHaze, bounce = true, overlay = false, depthOfField, sideBlur, chromatic, phase }: PostProps) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;

  // Uniforms outlive the graph so settings can change without a shader recompile.
  const uniforms = useMemo(
    () => ({
      haze: uniform(look.haze),
      aoStrength: uniform(look.ao),
      aoReach: uniform(look.aoReach),
      grain: uniform(look.grain),
      vignette: uniform(look.vignette)
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const { stack, tuners, hazeDepth, sceneDepth } = useMemo(() => {
    const backendIsWebGPU = (gl.backend as any).isWebGPUBackend === true;
    const tier: QualityTier = backendIsWebGPU ? quality : "low";
    const stack = new THREE.RenderPipeline(gl as any);
    stack.outputColorTransform = false;

    const scenePass: any = pass(scene, camera);
    let color: any;
    let useTemporal = false;
    const tuners: ((next: Look) => void)[] = [];
    let hazeDepth: any = null;
    let sceneDepth: any = null;

    if (tier === "low") {
      color = scenePass.getTextureNode("output");
    } else {
      scenePass.setMRT(
        mrt({
          output,
          diffuseColor,
          normal: packNormalToRGB(normalView),
          velocity
        })
      );
      scenePass.getTexture("normal").type = THREE.UnsignedByteType;
      scenePass.getTexture("diffuseColor").type = THREE.UnsignedByteType;

      const beauty = scenePass.getTextureNode("output");
      const depth = scenePass.getTextureNode("depth");
      const normalNode = scenePass.getTextureNode("normal");
      const decodedNormal = sample((uv: any) => unpackRGBToNormal(normalNode.sample(uv)));
      useTemporal = true;

      if (tier === "high" && bounce) {
        const giPass: any = ssgi(beauty, depth, decodedNormal as any, camera);
        giPass.sliceCount.value = 2;
        giPass.stepCount.value = 8;
        giPass.radius.value = 8;
        tuners.push((next) => {
          giPass.giIntensity.value = next.gi;
          giPass.aoIntensity.value = next.ao;
        });
        const diffuse = scenePass.getTextureNode("diffuseColor");
        // Since r187 the pass keeps occlusion and bounce light in separate textures: its own output is the occlusion
        // alone, in red, and the bounce light is a texture of its own.
        const occlusion = giPass.getAONode().r;
        const bounceLight = giPass.getGINode().rgb;
        color = vec4(add(beauty.rgb.mul(occlusion), diffuse.rgb.mul(bounceLight)), beauty.a);
      } else {
        const aoPass: any = ao(depth, decodedNormal as any, camera);
        aoPass.resolutionScale = 0.5;
        tuners.push((next) => {
          aoPass.radius.value = next.aoRadius;
        });
        aoPass.samples.value = 12;
        const occlusion = float(1).sub(float(1).sub(aoPass.getTextureNode().r).mul(uniforms.aoStrength));
        // Depth is too coarse a long way off, and occlusion there breaks up into a grid of dots.
        const distance = (scenePass.getViewZNode() as any).negate();
        const fade = smoothstep(uniforms.aoReach, uniforms.aoReach.mul(1.6), distance);
        color = vec4(beauty.rgb.mul(mix(occlusion, float(1), fade)), beauty.a);
      }
    }

    if (hasHaze && tier !== "low") {
      const hazeLayer = new THREE.Layers();
      hazeLayer.disableAll();
      hazeLayer.enable(HAZE_LAYER);

      const hazePass: any = pass(scene, camera, { depthBuffer: false } as any);
      hazePass.setLayers(hazeLayer);
      hazePass.setResolutionScale(tier === "high" ? 0.33 : 0.25);
      const soft: any = gaussianBlur(hazePass, 0.7);
      color = vec4(color.rgb.add(soft.rgb.mul(uniforms.haze)), color.a);

      hazeDepth = scenePass.getTextureNode("depth");
    }

    if (useTemporal) {
      color = traa(color, scenePass.getTextureNode("depth"), scenePass.getTextureNode("velocity"), camera);
    }

    // Air between the lens and whatever it sees, thickening with distance up to a limit.
    const isSky = depthOfField?.sharpSky ? (scenePass.getTextureNode("depth") as any).r.greaterThanEqual(0.99999) : null;
    if (depthOfField?.air) {
      const seen = (scenePass.getViewZNode() as any).negate();
      const through = depthOfField.airBehindFocus === undefined ? seen : seen.sub((focusDistance as any).sub(depthOfField.airBehindFocus)).max(0);
      const thick = float(1).sub(exp(through.mul(-(depthOfField.airRate ?? 0.022)))).mul(depthOfField.air).mul(airAmount) as any;
      color = vec4(mix((color as any).rgb, airTint, isSky ? isSky.select(float(0), thick) : thick), 1) as any;
    }

    if (depthOfField && tier !== "low") {
      const viewZ = scenePass.getViewZNode() as any;
      color = dof(color, isSky ? isSky.select((focusDistance as any).negate(), viewZ) : viewZ, focusDistance, uniform(depthOfField.range), focusBlur);
    }

    if (sideBlur) {
      const soft: any = gaussianBlur(color, sideBlur.amount, tier === "low" ? 3 : 5);
      let weight: any = smoothstep(sideBlur.from, sideBlur.to, screenUV.x);
      if (sideBlur.left) weight = weight.max(float(1).sub(smoothstep(sideBlur.left.to, sideBlur.left.from, screenUV.x)).mul(sideBlur.left.strength));
      color = vec4((mix as any)((color as any).rgb, soft.rgb, weight), 1) as any;
    }

    if (chromatic && tier !== "low") {
      color = chromaticAberration(color as any, uniform(chromatic), vec2(0.5, 0.5) as any, float(1) as any) as any;
    }

    if (overlay) {
      const overlayLayer = new THREE.Layers();
      overlayLayer.disableAll();
      overlayLayer.enable(OVERLAY_LAYER);
      const overlayPass: any = pass(scene, camera, { depthBuffer: false } as any);
      overlayPass.setLayers(overlayLayer);
      color = vec4(color.rgb.add(overlayPass.rgb), color.a);
      sceneDepth = scenePass.getTextureNode("depth");
    }

    const glow: any = bloom(color, look.bloom, 0.6, look.bloomThreshold);
    tuners.push((next) => {
      glow.strength.value = next.bloom;
      glow.threshold.value = next.bloomThreshold;
    });
    color = vec4(color.rgb.add(glow.rgb), 1);

    // Display transform, then grade in display space so grain sits on top of the image.
    let graded: any = renderOutput(color, THREE.NeutralToneMapping, THREE.SRGBColorSpace);
    if (tier === "low") graded = fxaa(graded);

    const fromCentre = length(screenUV.sub(vec2(0.5)).mul(vec2(1.15, 1)));
    const falloff = float(1).sub(fromCentre.sub(0.35).max(0).mul(uniforms.vignette).mul(2.2));
    const noise = fract(
      sin(dot(screenUV.add(fract(time.mul(7.13))), vec2(12.9898, 78.233))).mul(43758.5453)
    ).sub(0.5);
    stack.outputNode = vec4(graded.rgb.mul(falloff).add(vec3(noise.mul(uniforms.grain))), 1);
    return { stack, tuners, hazeDepth, sceneDepth };
    // Only the things that change the graph's shape are dependencies. Look values go through tuners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, quality, hasHaze, bounce, overlay, depthOfField, sideBlur, chromatic, uniforms]);

  useEffect(() => {
    gl.toneMappingExposure = look.exposure;
    uniforms.haze.value = look.haze;
    uniforms.aoStrength.value = look.ao;
    uniforms.aoReach.value = look.aoReach;
    uniforms.grain.value = look.grain;
    uniforms.vignette.value = look.vignette;
    scene.background = new THREE.Color(look.background);
    tuners.forEach((tune) => tune(look));
  }, [gl, scene, look, uniforms, tuners]);

  // In an effect, because React's dev mode runs the memo above twice and keeps only one result.
  useEffect(() => {
    if (hazeDepth) hazeLink.setDepth(hazeDepth);
    if (sceneDepth) overlayLink.setDepth(sceneDepth);
  }, [hazeDepth, sceneDepth]);

  useEffect(() => () => stack.dispose(), [stack]);

  // Priority 1 takes over from R3F's own render call.
  useFrame(() => {
    if (phase.current === "hold") return;
    stack.render();
  }, 1);

  return null;
}
