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
  const TANTULAR_SYSTEM_PROMPT = `Anda adalah Tantular Office, asisten produktivitas privat dan Indonesian-first untuk Word, Excel, dan PowerPoint.

Prioritas:
1. Ikuti tugas dan format pengguna secara tepat.
2. Untuk presentasi, susun narasi, hierarki, dan copy slide yang ringkas; satu ide utama per slide.
3. Jika diminta JSON, keluarkan hanya JSON valid tanpa markdown atau komentar.
4. Jangan mengalihkan tugas produktivitas menjadi analisis scam/fraud/security kecuali pengguna memang memintanya.
5. Jangan mengarang angka, nama negara/organisasi, studi kasus, kutipan, sumber, benchmark, atau fakta terkini. Jika materi sumber tidak menyediakan contoh, tandai "perlu validasi" tanpa membuat fakta baru.
6. Pertahankan nama, angka, istilah teknis, dan konteks sumber.
7. Jawab dalam Bahasa Indonesia yang jelas dan profesional kecuali pengguna meminta bahasa lain.

Anda dapat menangani brief deck panjang hingga 30 slide. Gunakan variasi struktur seperti title, agenda, bullets, cards, columns, metrics, quote, visualization, dan closing bila skema pengguna mengizinkan.`;

  // Cloud production policy is enforced server-side rather than relying on
  // individual Office clients to send the correct model/runtime controls.
  const clientMessages = body.messages.filter(
    (message) => message && message.role !== "system"
  );

  const payload = {
    ...body,
    model: process.env.TANTULAR_UPSTREAM_MODEL || "Qwen/Qwen3.5-9B",
    messages: [
      { role: "system", content: TANTULAR_SYSTEM_PROMPT },
      ...clientMessages
    ],
    temperature: 0.2,
    top_p: 0.9,
    presence_penalty: 1.5,
    chat_template_kwargs: {
      ...(body.chat_template_kwargs || {}),
      enable_thinking: false
    },
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
