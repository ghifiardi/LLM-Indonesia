import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectSideloadManifest,
  taskpaneUrlsFromManifest
} from "../tools/doctor.mjs";

const localManifest = (port = 3000) => `<?xml version="1.0"?>
<OfficeApp xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0">
  <DefaultSettings>
    <SourceLocation DefaultValue="https://localhost:${port}/src/taskpane.html" />
  </DefaultSettings>
  <bt:Urls>
    <bt:Url id="Taskpane.Url.Word"
      DefaultValue="https://localhost:${port}/src/taskpane.html?host=Word&amp;boot=123" />
  </bt:Urls>
</OfficeApp>`;

test("doctor extracts and XML-decodes the task-pane URLs", () => {
  assert.deepEqual(taskpaneUrlsFromManifest(localManifest()), [
    "https://localhost:3000/src/taskpane.html",
    "https://localhost:3000/src/taskpane.html?host=Word&boot=123"
  ]);
});

test("doctor accepts a local sideload that matches the Companion port", () => {
  const result = inspectSideloadManifest(localManifest(3000), { expectedPort: 3000 });
  assert.equal(result.ok, true);
});

test("doctor rejects a stale temporary sideload port", () => {
  const result = inspectSideloadManifest(localManifest(3010), { expectedPort: 3000 });
  assert.equal(result.ok, false);
  assert.match(result.detail, /localhost:3010/);
  assert.match(result.detail, /port 3000/);
});

test("doctor accepts a hosted production task pane", () => {
  const xml = `<OfficeApp><DefaultSettings>
    <SourceLocation DefaultValue="https://office.tantular.ai/src/taskpane?v=7" />
  </DefaultSettings></OfficeApp>`;
  assert.equal(inspectSideloadManifest(xml, { expectedPort: 3000 }).ok, true);
});

test("doctor rejects a manifest with no usable task-pane URL", () => {
  const result = inspectSideloadManifest("<OfficeApp />");
  assert.equal(result.ok, false);
  assert.match(result.detail, /SourceLocation/);
});
