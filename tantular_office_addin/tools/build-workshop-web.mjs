import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "workshop-web");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

copyDir(path.join(root, "src"), path.join(out, "src"));
copyDir(path.join(root, "assets"), path.join(out, "assets"));
for (const name of ["index.html", "privacy.html", "support.html", "vercel.json"]) {
  fs.copyFileSync(path.join(root, "workshop", name), path.join(out, name));
}

// Serverless routes for portal mode (browser, nothing installed). The upstream
// API key lives in Vercel env vars and is read server-side here, never shipped
// to the page. Absent this directory the portal simply has no model and says so.
const apiSrc = path.join(root, "workshop", "api");
if (fs.existsSync(apiSrc)) copyDir(apiSrc, path.join(out, "api"));

console.log(`Workshop web release created: ${out}`);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}
