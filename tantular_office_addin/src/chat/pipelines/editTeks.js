import { runTantular } from "../../tantularClient.js";
import { EDIT_SYSTEM_PROMPT, parseEditContract, resolveEdits } from "../editContract.js";
import { getDocumentBodyText } from "../../officeClient.js";

export async function runEditTeks({ instruction, contextText, emit }) {
  const scope = contextText
    ? `Teks yang harus diedit (dari dokumen):\n"""${contextText.slice(0, 6000)}"""`
    : "";
  emit?.("Menyusun usulan edit…");
  const raw = await runTantular({
    system: EDIT_SYSTEM_PROMPT,
    user: `${instruction}\n\n${scope}`.trim(),
    maxTokens: 1400,
    temperature: 0.1
  });
  const { edits } = parseEditContract(raw);
  const body = await getDocumentBodyText();
  return { kind: "edits", edits: resolveEdits(body, edits) };
}
