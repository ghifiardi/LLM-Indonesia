import { runTantular } from "../../tantularClient.js";
import { EDIT_SYSTEM_PROMPT, parseEditContract, resolveEdits } from "../editContract.js";
import { getDocumentBodyText } from "../../officeClient.js";
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
      return { kind: "edits", edits: resolveEdits(body, [recipe]) };
    }
  }
  const scope = contextText
    ? `Teks yang harus diedit (dari dokumen):\n"""${contextText.slice(0, 6000)}"""`
    : "";
  emit?.("Menyusun usulan edit…");
  const raw = await runTantular({
    system: EDIT_SYSTEM_PROMPT,
    user: `${instruction}\n\n${scope}`.trim(),
    maxTokens: 1400,
    temperature: 0.1,
    signal,
    // A large selection means one JSON edit per sentence — long structured
    // output, same shape of problem as Studio just on the fast/small chat
    // model — so this needs Studio's kind of timeout headroom, not the
    // short budget plain Q&A chat gets. See runTantular in tantularClient.js.
    task: "edit"
  });
  const { edits, skipped } = parseEditContract(raw);
  const body = await getDocumentBodyText();
  return { kind: "edits", edits: resolveEdits(body, edits), skipped };
}
