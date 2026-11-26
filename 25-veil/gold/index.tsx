"use client";

import { LOOKS } from "../blur/looks";
import { blurred } from "../blur/scene";

// Veil, statues before a world out of focus: gold.
export default blurred(LOOKS.gold, "gold");
