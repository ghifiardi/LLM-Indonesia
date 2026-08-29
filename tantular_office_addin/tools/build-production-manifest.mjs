import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const baseUrl = valueFor("--base-url").replace(/\/+$/, "");
// Default to a fresh, always-different token: build-workshop-package.mjs (the
// only real caller, via release-workshop.mjs) never passes --release, so a
// static fallback here means every production deploy since ships the exact
// same cache-busting value — silently defeating the reason this exists (see
// the comment below on Office's WebView caching bug). --release stays
// available for a caller that deliberately wants a deterministic/pinned value.
const release = valueFor("--release", String(Date.now()));
const output = path.resolve(valueFor("--out", path.join(root, "dist", "workshop-package", "tantular-workshop-manifest.xml")));

if (!/^https:\/\/[^/]+/i.test(baseUrl)) {
  throw new Error("--base-url must be a public HTTPS origin.");
}

let xml = fs.readFileSync(path.join(root, "manifest.xml"), "utf8");
xml = xml
  .replace("<Version>0.9.0.0</Version>", "<Version>1.0.0.1</Version>")
  .replaceAll("https://localhost:3000/assets/", `${baseUrl}/assets/`)
  // Extensionless, not /src/taskpane.html: the production host serves this
  // behind Vercel's cleanUrls, which 308-redirects .html to the bare path.
  // The dev server has no such rewrite, so localhost keeps the .html form —
  // only the production target skips the hop, since Office's own task pane
  // webview loading a URL it then gets redirected away from (now carrying a
  // manifest-injected ?host= query string) is exactly the kind of thing an
  // older/limited host WebView is free to choke on.
  .replaceAll("https://localhost:3000/src/taskpane.html", `${baseUrl}/src/taskpane`)
  .replace('https://localhost:3000/README.md', `${baseUrl}/support.html`)
  .replace('https://localhost:3000/docs/MVP_PLAN.md', `${baseUrl}/support.html`)
  .replace(
    `<AppDomain>https://localhost:3000</AppDomain>`,
    `<AppDomain>${baseUrl}</AppDomain>`
  );

// Office desktop WebViews can preserve a previously loaded task-pane
// navigation even when the server returns Cache-Control: no-store.
// Version the navigation URL so every production release is unambiguous.
xml = xml
  .replaceAll(
    `${baseUrl}/src/taskpane?host=Word`,
    `${baseUrl}/src/taskpane?host=Word&amp;v=${release}`
  )
  .replaceAll(
    `${baseUrl}/src/taskpane?host=Excel`,
    `${baseUrl}/src/taskpane?host=Excel&amp;v=${release}`
  )
  .replaceAll(
    `${baseUrl}/src/taskpane?host=PowerPoint`,
    `${baseUrl}/src/taskpane?host=PowerPoint&amp;v=${release}`
  )
  .replace(
    `<SourceLocation DefaultValue="${baseUrl}/src/taskpane" />`,
    `<SourceLocation DefaultValue="${baseUrl}/src/taskpane?v=${release}" />`
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
