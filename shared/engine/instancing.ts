import * as THREE from "three/webgpu";
import { positionLocal } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- reaches into how a node material sets up its vertices. */

// A material's own vertex position on an instanced mesh is where the vertex sits on that instance, before the instance
// is moved into place: so a tile can be shaped and curled around its own middle, and then put where it belongs. Up to
// r184 three worked it out in that order. From r187 it places the instance first and then takes the material's position
// as final, so every instance lands at the middle of the object. This puts the old order back, for every day.
const proto = THREE.NodeMaterial.prototype as any;
if (!proto.__instancedPositionFirst) {
  proto.__instancedPositionFirst = true;
  const setupPosition = proto.setupPosition;
  proto.setupPosition = function (this: any, builder: any) {
    const object = builder.object;
    const own = this.positionNode;
    if (own === null || own === undefined || !object?.isInstancedMesh || object.instanceMatrix?.isInstancedBufferAttribute !== true) {
      return setupPosition.call(this, builder);
    }
    // The material's position first, then the rest as three does it, now without a position of its own to overwrite
    // the placed one.
    (positionLocal as any).assign(own);
    this.positionNode = null;
    try {
      return setupPosition.call(this, builder);
    } finally {
      this.positionNode = own;
    }
  };
}
