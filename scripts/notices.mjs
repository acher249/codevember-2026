// Writes public/THIRD_PARTY_NOTICES.txt, so that the licenses of everything the built site contains ship along with it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const sections = [];

for (const [path, info] of Object.entries(lock.packages)) {
  if (!path || info.dev || info.optional || !existsSync(join(root, path))) continue;
  const name = path.replace(/^.*node_modules\//, "");
  const licenseFile = readdirSync(join(root, path)).find((file) => /^(licen[sc]e|copying|notice)/i.test(file));
  const text = licenseFile ? readFileSync(join(root, path, licenseFile), "utf8").trim() : `Licensed under ${info.license ?? "the terms in the package's repository"}.`;
  sections.push(`${name} ${info.version}\n\n${text}`);
}
for (const file of readdirSync(join(root, "licenses"))) sections.push(`${file.replace(/^OFL-|\.txt$/g, "")} font\n\n${readFileSync(join(root, "licenses", file), "utf8").trim()}`);

writeFileSync(join(root, "public/THIRD_PARTY_NOTICES.txt"), `Third-party software and fonts in this site. See CREDITS.md in the repository for scans and techniques.\n\n${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`);
console.log(`Wrote the notices for ${sections.length} packages and fonts.`);
