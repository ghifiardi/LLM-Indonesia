// Portal-only model gateway.
//
// The portal lets someone use Tantular with no install at all — no Ollama, no
// Python companion, no Node bridge, no certificate. That convenience has a cost
// the user must be told about: their text leaves their machine. This function is
// the ONLY place that happens, and it exists so the upstream API key stays on
// the server. A key shipped in page JavaScript is a public key.
//
// An installed Office add-in reaches this route ONLY in a deliberate Cloud Mode
// session: companionUrl() keeps it pointed at the local companion unless the user
// switched modes in the pane, and loadMode() honours that switch only when the
// consent record carries chosenInOffice — which nothing but the in-pane toggle,
// running under a real Office host, can write (see src/companionUrl.js). An install
// left alone therefore never sends text here; one whose owner chose cloud does.
//
// Configure in Vercel → Project → Settings → Environment Variables:
//   TANTULAR_UPSTREAM_URL    OpenAI-compatible chat-completions endpoint
//   TANTULAR_UPSTREAM_KEY    bearer token for that endpoint
//   TANTULAR_UPSTREAM_MODEL  model id to force (optional; else the client's)
// Nothing here has a default that silently costs money: with no URL and key set,
// the route refuses and says so.

// The shim below waits for the whole upstream completion before writing a byte, so a
// long generation — this deployment advertises decks up to 30 slides — can outlive the
// platform's default function duration and be killed mid-wait, delivering nothing at
// all rather than partial text. 60s is the ceiling on every Vercel plan including
// Hobby, so this is the largest value that is safe to deploy anywhere; a Pro or
// Enterprise deployment that wants headroom for the longest decks should raise it.
export const config = { maxDuration: 60 };

const MAX_BODY_BYTES = 256 * 1024;

// The client's streaming path (runTantularStream in src/tantularClient.js) sends
// stream:true and reads SSE `data:` frames, taking choices[0].delta.content
// (src/chat/sse.js only yields lines beginning with "data:"). This route calls the
// upstream with stream:false on purpose, so `usage` comes back in-band and the meter
// never has to parse a stream — which left the streamed pipelines reading a plain JSON
// body, finding no frames, and failing with "Model tidak mengembalikan teks."
//
// So the completion is re-emitted here in the shape that parser expects.
//
// This is a SHIM, not streaming: the text still arrives in one burst after the full
// wait. True passthrough streaming is a deferred milestone and carries a billing
// consequence — see docs/superpowers/specs/2026-08-29-cloud-metered-billing-design.md
// section 4.9 — so it is deliberately not attempted here. The completion is split
// across two frames rather than one: a content frame, then a final frame that carries
// usage and finish_reason, keeping those in-band for the future meter.
function sseFromCompletion(rawJsonText) {
  let parsed = null;
  try { parsed = JSON.parse(rawJsonText); } catch { parsed = null; }
  const hasChoice = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
  const choice = parsed?.choices?.[0] ?? {};
  const content = String(choice.message?.content ?? "");

  // An unparseable or contentless upstream reply yields an empty delta on purpose:
  // the client then raises its own "Model tidak mengembalikan teks.", which is the
  // truthful outcome, rather than this route inventing text.
  const chunk = (delta, finishReason, extra = {}) => JSON.stringify({
    id: parsed?.id ?? null,
    object: "chat.completion.chunk",
    model: parsed?.model ?? null,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra
  });

  // No choice at all means finish_reason must be null, not a falsely reported "stop" —
  // a future meter should be able to tell "no choice" apart from "the model stopped".
  return `data: ${chunk({ role: "assistant", content }, null)}\n\n`
    + `data: ${chunk({}, hasChoice ? (choice.finish_reason ?? "stop") : null, { usage: parsed?.usage ?? null })}\n\n`
    + "data: [DONE]\n\n";
}

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

  // Cloud production policy still overrides model/temperature/sampling below
  // — none of that is negotiable from the client. The system message is
  // different: every structured pipeline (EDIT_TEKS's strict "reply with
  // ONLY JSON" contract, Deck/Document/Workbook Studio's schemas, ...) DEPENDS
  // on its own task-specific system prompt to get a parseable response at
  // all. Unconditionally replacing it with this generic one — confirmed by
  // reproducing it directly against the live endpoint — made the model
  // ignore the JSON-only instruction and answer in prose instead, so every
  // structured feature was broken in Cloud Mode, not just producing wrong
  // output but failing outright once the client tried to parse it. The
  // client here is our own packaged Office add-in and the hosted portal
  // page, both of which we control the source of; there's no legitimate
  // caller of this endpoint whose system prompt needs distrusting the way an
  // arbitrary third party's would. Use the client's system message when it
  // sends one, and only fall back to the generic assistant prompt otherwise
  // (e.g. a raw request with no system role at all).
  const clientSystemMessage = body.messages.find((message) => message?.role === "system");
  const clientMessages = body.messages.filter(
    (message) => message && message.role !== "system"
  );

  const payload = {
    ...body,
    model: process.env.TANTULAR_UPSTREAM_MODEL || "Qwen/Qwen3.5-9B",
    messages: [
      { role: "system", content: String(clientSystemMessage?.content || "").trim() || TANTULAR_SYSTEM_PROMPT },
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
  // The client always sends reasoning_effort: "none" (its way of disabling
  // thinking against a local Ollama endpoint — see reasoningControlFor in
  // src/tantularClient.js), spread in above via ...body. This upstream
  // rejects that field outright with a 400 — confirmed by reproducing it
  // directly against the live endpoint — which made EVERY cloud request fail
  // on its first (and only) attempt: the client's own retry-without-
  // reasoning_effort logic exists for exactly this, but never got the chance
  // to run, because the generic error message below never contained the
  // "reasoning" keyword that retry looks for. This deployment already has an
  // equivalent — chat_template_kwargs.enable_thinking above — so the field is
  // simply redundant here, not meaningful to forward.
  delete payload.reasoning_effort;

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

    // Answer in the shape the caller asked for. Errors above stay JSON: the client's
    // streaming path reads them with response.text() before touching the body stream.
    if (body.stream === true) {
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      return response.status(200).send(sseFromCompletion(text));
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
