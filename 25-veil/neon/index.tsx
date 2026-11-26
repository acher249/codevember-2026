"use client";

import { LOOKS } from "../blur/looks";
import { blurred } from "../blur/scene";

// Veil, statues before a world out of focus: neon.
export default blurred(LOOKS.neon, "neon");
