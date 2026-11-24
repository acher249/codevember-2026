import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HubPage } from "@/shared/hub/HubPage";

// The calendar is drawn by the stage in the layout. This page is the calendar as plain HTML, served with the page, on show
// from the first paint while the stage builds the 3D behind it (shared/hub/HubPage.tsx).
export default function CalendarPage() {
  // Read when the site is built: which days have a poster of the hub's own.
  const hubPosters = readdirSync(join(process.cwd(), "public/hub"))
    .filter((name) => name.endsWith(".jpg"))
    .map((name) => name.slice(0, -4));
  return <HubPage hubPosters={hubPosters} />;
}
