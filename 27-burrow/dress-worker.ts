// Works out each cavern's dressing off the page (dress.ts). It keeps its own copy of every dig, sent in order with the
// meshing workers', so what it places stands on the rock as it now is.
import { CAVERNS, cavernsMeet, cellCavern, Rock, type Cavern, type Edit } from "./field";
import { dress, pack } from "./dress";

const rock = new Rock();

type Ref = { cell?: [number, number, number]; hand?: number };
type Message = { type: "edit"; edit: Edit } | { type: "dress"; id: number; cell: [number, number, number] } | { type: "meets"; id: number; a: Ref; b: Ref };

// A cavern as the page names it: a hashed cell's, or one of those made by hand.
const cavernOf = (ref: Ref): Cavern | null => (ref.cell ? cellCavern(...ref.cell) : (CAVERNS[ref.hand as number] ?? null));

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.type === "edit") {
    rock.add(message.edit);
    return;
  }
  // Whether two caverns' air meets (World.sealed): in doubt, yes.
  if (message.type === "meets") {
    const a = cavernOf(message.a);
    const b = cavernOf(message.b);
    self.postMessage({ type: "meets", id: message.id, meet: !a || !b || cavernsMeet(a, b) });
    return;
  }
  const cavern = cellCavern(...message.cell);
  if (!cavern) {
    self.postMessage({ type: "dressed", id: message.id, packed: null });
    return;
  }
  const { packed, transfer } = pack(dress(cavern, rock));
  self.postMessage({ type: "dressed", id: message.id, packed }, { transfer });
};
