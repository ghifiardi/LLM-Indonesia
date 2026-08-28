// Native Presentation Bridge — Phase N1.
//
//   node voice_deck/bridge/server.mjs [--port 8777] [--slides 8]
//
// A local HTTP service that accepts the same versioned command JSON the web
// deck already produces, and hands it to an adapter. In N1 that adapter is a
// dry run: it records intended actions and drives nothing.
//
// Node built-ins only, and bound to 127.0.0.1 explicitly — never 0.0.0.0,
// which would expose a presentation-control endpoint to the venue wifi.
//
// Endpoints:
//   GET  /health   liveness + adapter name. No token: you must be able to ask
//                  "is it up?" without holding a credential.
//   GET  /state    presentation state. Token required.
//   POST /command  validate + dispatch one command. Token required.
//
// There is deliberately NO endpoint that runs a shell command, AppleScript, or
// arbitrary code. The whole value of this phase is that the transport can be
// reviewed while it is still incapable of doing damage.
import http from "node:http";
import { createSessionToken, tokensMatch, extractToken, hostIsLoopback, originIsLoopback } from "./auth.mjs";
import { DryRunAdapter } from "./dryRunAdapter.mjs";
import { createAdapter, DEFAULT_ADAPTER } from "./adapterFactory.mjs";
import { dispatchCommand, parseBody, MAX_BODY_BYTES } from "./dispatch.mjs";

export const LOOPBACK = "127.0.0.1";

function corsHeaders(origin) {
  // Echo only a loopback origin. Never "*": that would let any page on the
  // internet read replies from a service that drives a presentation.
  if (!originIsLoopback(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type,x-tantular-token",
    "Access-Control-Max-Age": "600",
  };
}

function send(res, status, body, origin) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(origin),
  });
  res.end(payload);
}

export function createBridge({ token = createSessionToken(), adapter = new DryRunAdapter(), onLog = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${LOOPBACK}`);
    const origin = req.headers.origin;

    // Preflight is answered BEFORE the token check: a browser never sends
    // Authorization on an OPTIONS request, so requiring it here made every
    // cross-origin call fail with 401 before it began.
    if (req.method === "OPTIONS") {
      if (!originIsLoopback(origin)) return send(res, 403, { ok: false, error: "origin not allowed" }, origin);
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return undefined;
    }

    if (!hostIsLoopback(req.headers.host)) {
      return send(res, 403, { ok: false, error: "non-loopback Host refused" }, origin);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, service: "tantular-presentation-bridge", phase: "N1", adapter: adapter.name }, origin);
    }

    const presented = extractToken(req.headers);
    if (!tokensMatch(token, presented)) {
      onLog({ level: "warn", message: `rejected ${req.method} ${url.pathname}: bad or missing token` });
      return send(res, 401, { ok: false, error: "missing or invalid session token" }, origin);
    }

    if (req.method === "GET" && url.pathname === "/state") {
      Promise.resolve(adapter.state())
        .then((state) => {
          send(res, 200, {
            ok: true,
            state,
            recent: adapter.recentLog?.() ?? adapter.recentScripts?.() ?? [],
          }, origin);
        })
        .catch((error) => send(res, 500, { ok: false, error: `state failed: ${error.message}` }));
      return undefined;
    }

    if (req.method === "POST" && url.pathname === "/command") {
      const chunks = [];
      let size = 0;
      let aborted = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          send(res, 413, { ok: false, error: `body too large (max ${MAX_BODY_BYTES} bytes)` }, origin);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (aborted) return;
        const parsed = parseBody(Buffer.concat(chunks));
        if (!parsed.ok) return send(res, 400, { ok: false, error: parsed.error }, origin);
        dispatchCommand(adapter, parsed.value)
          .then(({ status, body }) => {
            onLog({ level: body.ok ? "info" : "warn", message: `${parsed.value.action ?? "?"} -> ${status}` });
            send(res, status, body, origin);
          })
          .catch((error) => {
            // Without this the request hangs forever and the presenter simply
            // sees nothing happen.
            onLog({ level: "warn", message: `dispatch rejected: ${error.message}` });
            send(res, 500, { ok: false, error: `dispatch failed: ${error.message}` }, origin);
          });
      });
      return undefined;
    }

    return send(res, 404, { ok: false, error: "unknown endpoint" }, origin);
  });

  return { server, token, adapter };
}

function main() {
  const argv = process.argv.slice(2);
  const valueFor = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const port = Number(valueFor("--port", 8777));
  const slideCount = Number(valueFor("--slides", 0));
  const adapterName = valueFor("--adapter", DEFAULT_ADAPTER);
  // Executing is opt-in on top of choosing an adapter: --adapter powerpoint
  // still only REHEARSES until --execute is passed as well.
  const rehearsal = !argv.includes("--execute");

  const chosen = createAdapter(adapterName, { slideCount, rehearsal });
  if (!chosen.ok) {
    console.error(chosen.error);
    process.exit(1);
  }

  const { server, token } = createBridge({
    adapter: chosen.adapter,
    onLog: ({ level, message }) => console.log(`[${level}] ${message}`),
  });

  // A busy port is an ordinary condition — another bridge, or the Tantular
  // companion on a neighbouring port. Reporting it as an unhandled 'error'
  // event dumps a Node stack trace on someone who is about to present.
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use on ${LOOPBACK}.`);
      console.error(`Start on another port:  node voice_deck/bridge/server.mjs --port ${port + 1}`);
    } else {
      console.error(`Bridge could not start: ${error.message}`);
    }
    process.exit(1);
  });

  server.listen(port, LOOPBACK, () => {
    console.log(`Tantular presentation bridge on http://${LOOPBACK}:${port}`);
    console.log(`Session token: ${token}`);
    console.log("Send it as:  Authorization: Bearer <token>   (or x-tantular-token)");
    console.log(`Adapter: ${adapterName}${rehearsal ? " (rehearsal — scripts logged, nothing executed)" : " (EXECUTING against the live app)"}`);
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
