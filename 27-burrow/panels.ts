// Burrow's panels block the game: while a modal view is open (a find to turn over, a photo), nothing digs, looks round,
// walks or mounts a torch, and a press or release on any panel never reaches the scene. One check for the scene's
// input handlers to call.

export const panels = {
  // How many modal views are open.
  modal: 0,
  listeners: new Set<() => void>(),
  version: 0,
  open() {
    this.modal++;
    this.changed();
  },
  close() {
    this.modal = Math.max(0, this.modal - 1);
    this.changed();
  },
  changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
};

// Every panel's root carries this attribute.
export const PANEL = "data-burrow-panel";

// Whether the scene should ignore this input: a modal view is open, or the event is on a panel.
export function uiBlocks(event?: Event) {
  if (panels.modal > 0) return true;
  const target = event?.target as Element | null | undefined;
  return !!target?.closest?.(`[${PANEL}]`);
}
