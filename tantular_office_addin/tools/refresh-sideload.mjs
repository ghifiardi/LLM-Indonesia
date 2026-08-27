// Re-stamps the sideloaded manifest.xml in each Office app's wef folder with a
// fresh cache-busting query param, every time the companion starts.
//
// The per-request ?v= busting in dev-server.mjs only helps once Office is
// actually fetching the pane over the network. Office's Mac task pane WebView
// has been observed serving a stale top-level document — the taskpane.html
// page itself, before any of its scripts run — straight from its own cache
// across app relaunches, ignoring Cache-Control entirely. Manual "Clear Web
// Cache" + Reload is the only thing that has been reliable there, and asking
// every workshop attendee to do that on every launch is not workable.
//
// Since the SourceLocation URL Office reads is the sideloaded manifest.xml
// (not our repo's manifest.xml, and not something Office re-fetches on its
// own), the fix has to happen at that layer: give the taskpane URL itself a
// query param that changes every time `npm start` runs. A cache keyed by URL
// cannot return a stale hit for a URL it has never been asked for before.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const WEF_DIRS = {
  Word: path.join(process.env.HOME || "", "Library/Containers/com.microsoft.Word/Data/Documents/wef"),
  Excel: path.join(process.env.HOME || "", "Library/Containers/com.microsoft.Excel/Data/Documents/wef"),
  PowerPoint: path.join(process.env.HOME || "", "Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef")
};

function bootVersion(boot) {
  // Office caches its parsed manifest catalogue by add-in ID + Version. A new
  // SourceLocation in a file with the old Version can therefore be ignored.
  // Encode epoch seconds into two schema-safe (0..65535) components so every
  // Companion restart gets a new catalogue identity without editing the source
  // manifest or overflowing Office's four-part version fields.
  const seconds = Math.floor(Number(boot) / 1000);
  return `0.9.${Math.floor(seconds / 65535) % 65535}.${seconds % 65535}`;
}

export function stampSideloadManifest(xml, {
  boot = String(Date.now()),
  port = Number(process.env.PORT || 3000)
} = {}) {
  const version = bootVersion(boot);
  return String(xml)
    .replace(/<Version>[^<]+<\/Version>/, `<Version>${version}</Version>`)
    // A temporary acceptance server (for example :3010) must not survive in
    // the installed manifest after the normal Companion returns to :3000.
    .replace(/https:\/\/localhost:\d+/g, `https://localhost:${port}`)
    .replace(/(https:\/\/localhost:\d+\/src\/taskpane\.html)(?:\?([^"']*))?/g,
      (_match, base, rawQuery = "") => {
        const query = rawQuery
          .split(/&amp;|&/)
          .filter(Boolean)
          .filter((part) => !/^boot=/.test(part));
        query.push(`boot=${boot}`);
        return `${base}?${query.join("&amp;")}`;
      });
}

export function refreshSideload(log = () => {}) {
  if (process.platform !== "darwin") return; // wef sideloading is a Mac-only mechanism
  const manifestPath = path.join(root, "manifest.xml");
  if (!fs.existsSync(manifestPath)) return;

  const boot = String(Date.now());
  const port = Number(process.env.PORT || 3000);
  const stamped = stampSideloadManifest(
    fs.readFileSync(manifestPath, "utf8"),
    { boot, port }
  );

  for (const [app, dir] of Object.entries(WEF_DIRS)) {
    const target = path.join(dir, "manifest.xml");
    // Only re-stamp apps already sideloaded — never sideload one that was
    // never set up (that is npm run sideload:*'s job, run once, deliberately).
    if (!fs.existsSync(target)) continue;
    fs.writeFileSync(target, stamped);
    log(`${app}: manifest sideload disegarkan (port=${port}, boot=${boot}).`);
  }
}
