import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash } from "node:crypto";

const ALLOWED_CONTENT_TYPES = Object.freeze([
  "text/html", "application/xhtml+xml", "text/plain", "application/pdf"
]);

function ipv4Number(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

export function isPublicIp(address) {
  const ip = String(address || "").toLowerCase();
  const family = net.isIP(ip);
  if (family === 4) {
    const n = ipv4Number(ip);
    const inRange = (base, bits) => (n >>> (32 - bits)) === (ipv4Number(base) >>> (32 - bits));
    return ![
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
      ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
      ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
      ["224.0.0.0", 4], ["240.0.0.0", 4]
    ].some(([base, bits]) => inRange(base, bits));
  }
  if (family === 6) {
    if (ip === "::" || ip === "::1") return false;
    if (ip.startsWith("fc") || ip.startsWith("fd") || /^fe[89ab]/.test(ip)
        || ip.startsWith("ff")) return false;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPublicIp(mapped[1]) : true;
  }
  return false;
}

export function allowedContentType(value, allowed = ALLOWED_CONTENT_TYPES) {
  const type = String(value || "").split(";")[0].trim().toLowerCase();
  return allowed.includes(type) ? type : "";
}

export async function resolvePublicHost(hostname, {
  lookup = dns.lookup
} = {}) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses?.length) throw new Error("dns_no_address");
  if (addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error("dns_private_or_reserved");
  }
  return addresses[0];
}

// For the user's OWN configured provider (e.g. a localhost SearXNG). Still
// resolves through DNS, but does not require a public address. Never used for
// discovered result pages.
export async function resolveHostAny(hostname, { lookup = dns.lookup } = {}) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses?.length) throw new Error("dns_no_address");
  return addresses[0];
}

// Node may call a custom lookup with `options.all=true` (notably when
// autoSelectFamily is active). Returning scalar form in that case makes the
// HTTP stack read `address: undefined`. Preserve the exact address we already
// vetted, but answer in the shape Node requested.
export function pinnedLookup(resolved) {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address: resolved.address, family: resolved.family }]);
      return;
    }
    callback(null, resolved.address, resolved.family);
  };
}

export async function networkRequestOnce(urlValue, {
  headers = {},
  timeoutMs = 8_000,
  maxBytes = 1_000_000,
  resolveHost = resolvePublicHost,
  allowHttp = false,
  allowPrivateHost = false
} = {}) {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error("scheme_not_allowed");
  }
  if (url.username || url.password) throw new Error("url_credentials_not_allowed");
  const resolved = allowPrivateHost
    ? await resolveHostAny(url.hostname)
    : await resolveHost(url.hostname);
  const transport = url.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers,
      timeout: timeoutMs,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      lookup: pinnedLookup(resolved)
    }, (res) => {
      const status = Number(res.statusCode || 0);
      const contentLength = Number(res.headers["content-length"] || 0);
      if (contentLength && contentLength > maxBytes) {
        res.destroy();
        reject(new Error("response_too_large"));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy(new Error("response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({
        status,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("fetch_timeout")));
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetchUrl(initialUrl, {
  policy,
  requestOnce = networkRequestOnce,
  headers = {},
  timeoutMs = 8_000,
  maxBytes = 1_000_000,
  maxRedirects = 3,
  allowHttp = false,
  allowPrivateHost = false,
  allowContentTypes = ALLOWED_CONTENT_TYPES
} = {}) {
  if (typeof policy !== "function") throw new Error("policy_required");
  let url = new URL(initialUrl).href;
  const redirects = [];
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const decision = policy(url);
    if (!decision?.allowed) {
      const error = new Error(`domain_blocked:${decision?.reason || "policy"}`);
      error.decision = decision;
      throw error;
    }
    const response = await requestOnce(url, {
      headers, timeoutMs, maxBytes, allowHttp, allowPrivateHost });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.location;
      if (!location) throw new Error("redirect_without_location");
      if (hop >= maxRedirects) throw new Error("too_many_redirects");
      const next = new URL(location, url).href;
      redirects.push({ from: url, to: next });
      url = next;
      continue;
    }
    const contentType = allowedContentType(response.headers?.["content-type"], allowContentTypes);
    if (!contentType) throw new Error("content_type_not_allowed");
    const body = Buffer.isBuffer(response.body)
      ? response.body : Buffer.from(response.body || "");
    if (body.length > maxBytes) throw new Error("response_too_large");
    return {
      requestedUrl: new URL(initialUrl).href,
      finalUrl: url,
      redirects,
      status: response.status,
      contentType,
      bytes: body.length,
      contentHash: createHash("sha256").update(body).digest("hex"),
      body,
      policy: decision
    };
  }
  throw new Error("too_many_redirects");
}
