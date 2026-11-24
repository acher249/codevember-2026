/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { cameraPosition, color, dot, float, max, mix, modelWorldMatrix, mx_noise_float, normalize, positionLocal, positionWorld, pow, reflect, smoothstep, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";

// The instant photo: a white card frame with a square picture, the deep strip at the bottom, a dark back. The picture
// is a live render of the next nest. While it is a print it is lit like paper under the sun and wears the film's look
// (warm, soft blacks, a little faded, a gloss on top) and it develops from a blank grey-brown; as the camera dives in
// it comes alive: the film look, the paper's light and the gloss all fall away until it is exactly the render, so the
// moment the next nest takes over the screen nothing changes.

// The picture is 7.9 cm square; the card round it 8.8 by 10.75, its centre below the picture's.
export const PICTURE = 7.9;
export const CARD = { w: 8.8, top: 4.55, bottom: -6.2, thick: 0.09 };

export function createPhoto() {
  const group = new THREE.Group();
  const u = {
    develop: uniform(0),
    alive: uniform(0),
    // The part of the picture that is in the render target: its corners in the picture (u0, v0, u1, v1), and how much
    // of the target it fills.
    rect: uniform(new THREE.Vector4(0, 0, 1, 1)),
    fill: uniform(new THREE.Vector2(1, 1)),
    // The light where it lies, copied from the world it is in.
    toSun: uniform(new THREE.Vector3(0, 1, 0)),
    sun: uniform(new THREE.Color(1, 1, 1)),
    sky: uniform(new THREE.Color(0.5, 0.5, 0.5)),
    ground: uniform(new THREE.Color(0.2, 0.2, 0.2)),
    shade: uniform(1)
  };

  // The card: white faces and edges, a black back.
  const height = CARD.top - CARD.bottom;
  const cardGeometry = new THREE.BoxGeometry(CARD.w, height, CARD.thick, 1, 1, 1);
  cardGeometry.translate(0, (CARD.top + CARD.bottom) / 2, -CARD.thick / 2);
  const white = new THREE.MeshStandardNodeMaterial({ roughness: 0.42 });
  white.colorNode = color("#f2f0ea").mul(mx_noise_float(positionLocal.mul(6)).mul(0.015).add(0.985)) as any;
  const back = new THREE.MeshStandardNodeMaterial({ color: "#1a1a1c", roughness: 0.5 });
  const card = new THREE.Mesh(cardGeometry, [white, white, white, white, white, back]);
  card.castShadow = true;
  card.receiveShadow = true;
  group.add(card);

  // The picture, a hair above the card.
  const pictureGeometry = new THREE.PlaneGeometry(PICTURE, PICTURE);
  pictureGeometry.translate(0, 0, 0.004);
  const picture = new THREE.MeshBasicNodeMaterial();
  const placeholder = new THREE.Texture();
  const r = u.rect as any;
  // Where in the target: the part drawn sits in its top left corner, and three reads a target's rows from the bottom.
  const inRect = uv().sub(r.xy).div(r.zw.sub(r.xy)) as any;
  const source = texture(placeholder, vec2(inRect.x.mul(u.fill.x), float(1).sub(float(1).sub(inRect.y).mul(u.fill.y)))) as any;
  {
    const raw = source.rgb as any;
    // As a print: the render mapped down into what paper can show, then given the film's look.
    const mapped = raw.mul(1.15).div(raw.add(0.85)) as any;
    const lum = dot(mapped, vec3(0.2126, 0.7152, 0.0722)) as any;
    let film: any = mix(vec3(lum), mapped, 0.82);
    film = film.mul(vec3(1.05, 1.0, 0.9)).mul(0.92).add(vec3(0.035, 0.03, 0.04));
    const edge = uv().sub(0.5).length() as any;
    film = film.mul(float(1).sub(smoothstep(0.35, 0.75, edge).mul(0.25)));
    // Developing: blank grey-brown, the shadows and blues arriving first, the warm colours last.
    const d = u.develop as any;
    const blank = vec3(0.21, 0.2, 0.16) as any;
    const per = vec3(smoothstep(0.25, 1.0, d), smoothstep(0.12, 0.85, d), smoothstep(0.0, 0.7, d)) as any;
    const ghost = mix(blank, film.mul(vec3(0.9, 0.95, 1.1)), per) as any;
    // Lit as paper where it lies, with a gloss over the top.
    // The picture's normal in the world: its local +z, turned with the card.
    const n = normalize((modelWorldMatrix as any).mul(vec4(0, 0, 1, 0)).xyz) as any;
    const light = (u.sun as any).mul(max(dot(n, u.toSun), 0)).mul(u.shade).add(mix(u.ground, u.sky, n.y.mul(0.5).add(0.5))) as any;
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const R = reflect(V.negate(), n) as any;
    const fresnel = pow(float(1).sub(max(dot(n, V), 0)), 5).mul(0.9).add(0.04) as any;
    const gloss = (u.sun as any).mul(pow(max(dot(R, u.toSun), 0), 300)).mul(0.6).add((u.sky as any).mul(fresnel).mul(0.5)) as any;
    const print = ghost.mul(light).mul(0.85).add(gloss) as any;
    picture.colorNode = mix(print, raw, u.alive) as any;
  }
  const pictureMesh = new THREE.Mesh(pictureGeometry, picture);
  group.add(pictureMesh);
  group.traverse((o) => (o.frustumCulled = false));

  return {
    group,
    u,
    picture,
    source,
    setTexture(t: THREE.Texture) {
      source.value = t;
    },
    geometries: [cardGeometry, pictureGeometry],
    materials: [white, back, picture]
  };
}
