import { runTantular } from "../../tantularClient.js";
import {
  EDIT_SYSTEM_PROMPT,
  LANGUAGE_FIX_SYSTEM_PROMPT,
  isLanguageFixRequest,
  parseEditContract,
  resolveEdits
} from "../editContract.js";
import { getDocumentBodyText } from "../../officeClient.js";
import { bodyRevision } from "../contextBuilder.js";
import {
  closedVsOpenWeightEdit,
  isClosedVsOpenWeightTopic
} from "../documentAnswerRecipes.js";

export async function runEditTeks({ instruction, contextText, emit, signal }) {
  if (isClosedVsOpenWeightTopic(instruction, contextText)) {
    const recipe = closedVsOpenWeightEdit(contextText);
    if (recipe) {
      emit?.("Menyusun usulan edit berbasis pola Tantular…");
      const body = await getDocumentBodyText();
      return { kind: "edits", edits: resolveEdits(body, [recipe]), revision: bodyRevision(body) };
    }
  }
  const languageFix = isLanguageFixRequest(instruction);
  const scope = contextText
    ? `Teks yang harus diedit (dari dokumen):\n"""${contextText.slice(0, 6000)}"""`
    : "";
  emit?.("Menyusun usulan edit…");
  // No chat history goes into this call (system + one user turn), so a long
  // conversation cannot push the reply into truncation; the budget only has
  // to cover the selection. 1400 tokens was measured too small on 2026-10-31:
  // a 1.8k-char "Perbaiki bahasa" selection hit done_reason "length" mid-JSON.
  const maxTokens = editTokenBudget(contextText);
  const ask = (tokens, extra = "") => requestContract({
    system: languageFix ? LANGUAGE_FIX_SYSTEM_PROMPT : EDIT_SYSTEM_PROMPT,
    user: `${instruction}\n\n${scope}${extra}`.trim(),
    maxTokens: tokens,
    signal
  });
  let parsed;
  try {
    try {
      parsed = await ask(maxTokens);
    } catch (error) {
      if (!RETRYABLE.has(error?.code) || signal?.aborted) throw error;
      // One retry. A truncated reply gets more room and a request to stay
      // compact; a malformed one gets the same request again.
      emit?.(" (balasan model tidak lengkap, mencoba sekali lagi…)");
      parsed = error.code === "EDIT_JSON_TRUNCATED"
        ? await ask(Math.min(MAX_EDIT_TOKENS, maxTokens * 2), COMPACT_RETRY_NOTE)
        : await ask(maxTokens);
    }
  } catch (error) {
    // A clean proofread is an answer, not a failure.
    if (languageFix && error?.code === "EDIT_EMPTY") {
      return { kind: "text", text: "Tidak ada kesalahan bahasa yang perlu diperbaiki pada teks ini." };
    }
    throw error;
  }
  const { edits, skipped } = parsed;
  const body = await getDocumentBodyText();
  return {
    kind: "edits",
    edits: resolveEdits(body, edits, { languageFix }),
    skipped,
    revision: bodyRevision(body)
  };
}

const MAX_EDIT_TOKENS = 4096;
const RETRYABLE = new Set(["EDIT_JSON_TRUNCATED", "EDIT_JSON_INVALID", "EDIT_JSON_MISSING"]);
const COMPACT_RETRY_NOTE = "\n\nBalasan sebelumnya terpotong. Balas lebih ringkas: find sependek mungkin, kosongkan before/after kecuali find berulang, alasan maksimal 5 kata.";

// Roughly one output token per 2.5 selected characters plus JSON overhead,
// bounded to [1400, 4096]. The office model runs with num_ctx 32768, so even
// a full 6000-char selection plus this budget fits comfortably.
export function editTokenBudget(contextText) {
  const chars = Math.min(6000, String(contextText ?? "").length);
  return Math.max(1400, Math.min(MAX_EDIT_TOKENS, Math.ceil(chars / 2.5) + 600));
}

async function requestContract({ system, user, maxTokens, signal }) {
  let metrics = null;
  const raw = await runTantular({
    system,
    user,
    maxTokens,
    temperature: 0.1,
    signal,
    onMetrics: (m) => { metrics = m; },
    // A large selection means one JSON edit per sentence — long structured
    // output, same shape of problem as Studio just on the fast/small chat
    // model — so this needs Studio's kind of timeout headroom, not the
    // short budget plain Q&A chat gets. See runTantular in tantularClient.js.
    task: "edit"
  });
  const finishReason = metrics?.finishReason ?? null;
  try {
    return parseEditContract(raw, { finishReason });
  } catch (error) {
    // Raw reply + finish reason for diagnosis (forwarded to the companion
    // trace only when TANTULAR_TRACE=1). Local console only.
    console.warn("[Tantular] edit contract parse failed", {
      code: error?.code ?? null,
      finishReason,
      completionTokens: metrics?.completionTokens ?? null,
      maxTokens,
      rawLength: String(raw ?? "").length,
      raw
    });
    throw error;
  }
}
