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
    signal
  });
  const { edits, skipped } = parseEditContract(raw);
  const body = await getDocumentBodyText();
  return { kind: "edits", edits: resolveEdits(body, edits), skipped };
}
