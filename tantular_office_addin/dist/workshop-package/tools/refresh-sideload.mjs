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

export function refreshSideload(log = () => {}) {
  if (process.platform !== "darwin") return; // wef sideloading is a Mac-only mechanism
  const manifestPath = path.join(root, "manifest.xml");
  if (!fs.existsSync(manifestPath)) return;

  const boot = String(Date.now());
  const stamped = fs
    .readFileSync(manifestPath, "utf8")
    // These URLs sit inside XML attribute values (DefaultValue="..."), where a
    // bare "&" is invalid XML — it must be the entity "&amp;". Missing this
    // corrupted every sideloaded manifest.xml, which made Word/Excel/PowerPoint
    // silently drop the whole add-in as unparseable rather than show an error.
    .replace(/(https:\/\/localhost:3000\/src\/taskpane\.html(?:\?[^"']*)?)/g, (url) => {
      const sep = url.includes("?") ? "&amp;" : "?";
      return `${url}${sep}boot=${boot}`;
    });

  for (const [app, dir] of Object.entries(WEF_DIRS)) {
    const target = path.join(dir, "manifest.xml");
    // Only re-stamp apps already sideloaded — never sideload one that was
    // never set up (that is npm run sideload:*'s job, run once, deliberately).
    if (!fs.existsSync(target)) continue;
    fs.writeFileSync(target, stamped);
    log(`${app}: manifest sideload disegarkan (boot=${boot}).`);
  }
}
