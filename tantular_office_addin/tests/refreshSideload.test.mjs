import test from "node:test";
import assert from "node:assert/strict";

import { stampSideloadManifest } from "../tools/refresh-sideload.mjs";

const xml = `<?xml version="1.0"?>
<OfficeApp>
  <Version>0.9.0.0</Version>
  <DefaultSettings>
    <SourceLocation DefaultValue="https://localhost:3010/src/taskpane.html" />
  </DefaultSettings>
  <bt:Url id="Taskpane.Url.Excel"
    DefaultValue="https://localhost:3010/src/taskpane.html?host=Excel&amp;boot=old" />
  <bt:Image DefaultValue="https://localhost:3010/assets/icon-32.png" />
</OfficeApp>`;

test("sideload stamp normalizes a temporary port and replaces old boot tokens", () => {
  const stamped = stampSideloadManifest(xml, { boot: "1787665000123", port: 3000 });
  assert.doesNotMatch(stamped, /localhost:3010/);
  assert.match(stamped, /localhost:3000\/src\/taskpane\.html\?boot=1787665000123/);
  assert.match(stamped,
    /taskpane\.html\?host=Excel&amp;boot=1787665000123/);
  assert.doesNotMatch(stamped, /boot=old/);
});

test("sideload stamp changes the Office catalogue version within valid bounds", () => {
  const first = stampSideloadManifest(xml, { boot: "1787665000123", port: 3000 });
  const second = stampSideloadManifest(xml, { boot: "1787665001123", port: 3000 });
  const version = first.match(/<Version>([^<]+)<\/Version>/)?.[1];
  assert.ok(version);
  const parts = version.split(".").map(Number);
  assert.equal(parts.length, 4);
  assert.ok(parts.every((part) => part >= 0 && part <= 65535));
  assert.notEqual(first.match(/<Version>([^<]+)/)?.[1],
    second.match(/<Version>([^<]+)/)?.[1]);
});

test("stamped manifest remains well-formed XML-safe around query parameters", () => {
  const stamped = stampSideloadManifest(xml, { boot: "1787665000123", port: 3000 });
  assert.doesNotMatch(stamped, /DefaultValue="[^"]*&boot=/);
  assert.match(stamped, /&amp;boot=/);
});
