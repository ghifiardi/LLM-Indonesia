import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyOcrImports,
  describeOcrFailure,
  OCR_IMPORT_PROBE,
  RETRY_COMMAND
} from "../tools/doc-setup.mjs";

// The probe must match the guarded import block in document-extractor.py. If
// that file starts importing something else, installing packages would still
// "succeed" while OCR fails at runtime — which is the bug this replaces.
test("OCR probe covers exactly the imports document-extractor.py performs", () => {
  for (const needed of ["import Vision", "Quartz", "from Foundation import NSData"]) {
    assert.ok(OCR_IMPORT_PROBE.includes(needed), `probe must include ${needed}`);
  }
});

test("verifyOcrImports: success requires the sentinel, not just exit 0", () => {
  const ok = verifyOcrImports("python", () => ({ status: 0, stdout: "OCR_IMPORTS_OK\n" }));
  assert.equal(ok.ok, true);

  // A python that exits 0 without running our code (a stub, a wrapper that
  // swallows the script) must NOT be treated as working OCR.
  const silent = verifyOcrImports("python", () => ({ status: 0, stdout: "", stderr: "" }));
  assert.equal(silent.ok, false, "exit 0 with no sentinel is not proof of import");
});

test("verifyOcrImports: partial install names the module that is actually missing", () => {
  // pyobjc-framework-Quartz installed, Vision missing — the realistic partial
  // failure. Reporting "pyobjc failed" would send someone at the wrong package.
  const result = verifyOcrImports("python", () => ({
    status: 1,
    stdout: "",
    stderr: "Traceback (most recent call last):\n  File \"<string>\", line 1\n"
          + "ModuleNotFoundError: No module named 'Vision'\n"
  }));
  assert.equal(result.ok, false);
  assert.equal(result.missingModule, "Vision");
  assert.match(result.detail, /No module named 'Vision'/);
});

test("verifyOcrImports: installed-but-unimportable is caught, not just missing", () => {
  // pyobjc can install and still fail to load — wrong architecture for the
  // interpreter, partial wheel, framework version mismatch. pip would report
  // success, so only an import check finds this.
  const result = verifyOcrImports("python", () => ({
    status: 1,
    stdout: "",
    stderr: "ImportError: dlopen(...Vision.so): tried: ... (mach-o file, but is "
          + "an incompatible architecture (have 'x86_64', need 'arm64'))\n"
  }));
  assert.equal(result.ok, false);
  assert.equal(result.missingModule, null, "not a missing module — an unloadable one");
  assert.match(result.detail, /incompatible architecture/);
});

test("failure output states the retry command and that OCR alone is affected", () => {
  const text = describeOcrFailure({ missingModule: "Vision", detail: "No module named 'Vision'" });
  assert.ok(text.includes(RETRY_COMMAND), "must print the exact retry command");
  assert.match(text, /PDF tetap berfungsi/, "must say PDF extraction still works");
  assert.match(text, /Vision/);
});

test("failure output degrades gracefully with no module name", () => {
  const text = describeOcrFailure({ missingModule: null, detail: "segmentation fault" });
  assert.ok(text.includes(RETRY_COMMAND));
  assert.match(text, /segmentation fault/);
});

// --- doctor: optional vs pane-load blocking ---------------------------------
import { isPaneBlocker } from "../tools/doctor.mjs";

test("doctor: optional components never block pane startup", () => {
  // Broken OCR or extractor must not stop `npm start` — the pane works without
  // them, and blocking would strand a user over a feature they may never use.
  assert.equal(isPaneBlocker({ name: "OCR gambar (opsional)" }), false);
  assert.equal(isPaneBlocker({ name: "Ekstraksi dokumen (opsional)" }), false);

  // These genuinely prevent the pane from loading at all.
  assert.equal(isPaneBlocker({ name: "Sertifikat Office" }), true);
  assert.equal(isPaneBlocker({ name: "Companion (dev-server)" }), true);
  assert.equal(isPaneBlocker({ name: "Ollama" }), true);
  assert.equal(isPaneBlocker({ name: "Model Tantular" }), true);
  assert.equal(isPaneBlocker({ name: "Manifest tersideload" }), true);
});
