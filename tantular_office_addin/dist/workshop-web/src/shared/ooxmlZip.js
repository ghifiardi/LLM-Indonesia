// Shared, dependency-free ZIP (store, no compression) → Base64 for OOXML
// packages (.pptx / .docx). Kept separate so both builders can reuse the exact
// same bytes-correct implementation.

export function zipBase64(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = utf8(name);
    const data = utf8(text);
    const crc = crc32(data);
    const local = concat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), nameBytes, data
    );
    parts.push(local);
    central.push(concat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBytes
    ));
    offset += local.length;
  }
  const centralStart = offset;
  const centralBlob = concat(...central);
  const end = concat(
    u32(0x06054b50), u16(0), u16(0),
    u16(files.size), u16(files.size),
    u32(centralBlob.length), u32(centralStart), u16(0)
  );
  const zip = concat(...parts, centralBlob, end);
  return bytesToBase64(zip);
}

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function utf8(s) { return new TextEncoder().encode(s); }
function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function concat(...arrays) {
  const len = arrays.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}
function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
