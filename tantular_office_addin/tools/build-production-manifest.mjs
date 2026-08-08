import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const baseUrl = valueFor("--base-url").replace(/\/+$/, "");
const output = path.resolve(valueFor("--out", path.join(root, "dist", "workshop-package", "tantular-workshop-manifest.xml")));

if (!/^https:\/\/[^/]+/i.test(baseUrl)) {
  throw new Error("--base-url must be a public HTTPS origin.");
}

let xml = fs.readFileSync(path.join(root, "manifest.xml"), "utf8");
xml = xml
  .replace("<Version>0.9.0.0</Version>", "<Version>1.0.0.0</Version>")
  .replaceAll("https://localhost:3000/assets/", `${baseUrl}/assets/`)
  .replaceAll("https://localhost:3000/src/taskpane.html", `${baseUrl}/src/taskpane.html`)
  .replace('https://localhost:3000/README.md', `${baseUrl}/support.html`)
  .replace('https://localhost:3000/docs/MVP_PLAN.md', `${baseUrl}/support.html`)
  .replace(
    `<AppDomain>https://localhost:3000</AppDomain>`,
    `<AppDomain>${baseUrl}</AppDomain>\n    <AppDomain>https://localhost:3000</AppDomain>`
  );

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, xml);
console.log(output);

function valueFor(flag, fallback = "") {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : fallback;
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}
