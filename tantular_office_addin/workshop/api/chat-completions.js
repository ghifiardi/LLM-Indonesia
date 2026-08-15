// Portal-only model gateway.
//
// The portal lets someone use Tantular with no install at all — no Ollama, no
// Python companion, no Node bridge, no certificate. That convenience has a cost
// the user must be told about: their text leaves their machine. This function is
// the ONLY place that happens, and it exists so the upstream API key stays on
// the server. A key shipped in page JavaScript is a public key.
//
// The installed Office add-in never reaches this route: companionUrl() keeps it
// pointed at the local companion whenever Office.js is present, so an install
// stays local-only exactly as promised.
//
// Configure in Vercel → Project → Settings → Environment Variables:
//   TANTULAR_UPSTREAM_URL    OpenAI-compatible chat-completions endpoint
//   TANTULAR_UPSTREAM_KEY    bearer token for that endpoint
//   TANTULAR_UPSTREAM_MODEL  model id to force (optional; else the client's)
// Nothing here has a default that silently costs money: with no URL and key set,
// the route refuses and says so.

const MAX_BODY_BYTES = 256 * 1024;

export default async function handler(request, response) {
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") {
    return response.status(405).json({ error: { message: "Gunakan POST." } });
  }

  const upstreamUrl = process.env.TANTULAR_UPSTREAM_URL;
  const upstreamKey = process.env.TANTULAR_UPSTREAM_KEY;
  if (!upstreamUrl || !upstreamKey) {
    return response.status(503).json({
      error: {
        message:
          "Mode portal belum dikonfigurasi: TANTULAR_UPSTREAM_URL dan TANTULAR_UPSTREAM_KEY "
          + "belum diisi di Vercel. Untuk sekarang gunakan Tantular versi lokal."
      }
    });
  }

  let body = request.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = null; }
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    return response.status(400).json({ error: { message: "Body harus JSON dengan array \"messages\"." } });
  }
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return response.status(413).json({
      error: { message: "Permintaan terlalu besar untuk mode portal. Pakai dokumen yang lebih kecil." }
    });
  }

  // The client's own model id is ignored when the deployment pins one, so a
  // portal visitor cannot bill the account for an arbitrary upstream model.
  const payload = {
    ...body,
    model: process.env.TANTULAR_UPSTREAM_MODEL || body.model,
    stream: false
  };

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`
      },
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      // Pass the status through, but never the upstream body verbatim — it can
      // carry account or key detail that does not belong in a public response.
      console.error("[tantular-portal] upstream error", upstream.status, text.slice(0, 500));
      return response.status(upstream.status).json({
        error: { message: `Gateway model menolak permintaan (${upstream.status}). Coba lagi sebentar.` }
      });
    }

    response.setHeader("Content-Type", "application/json");
    return response.status(200).send(text);
  } catch (error) {
    console.error("[tantular-portal] upstream unreachable", error);
    return response.status(502).json({
      error: { message: "Gateway model tidak dapat dihubungi. Coba lagi sebentar." }
    });
  }
}
