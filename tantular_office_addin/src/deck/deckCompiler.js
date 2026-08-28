// Tantular Deck Studio — reliable insertion/open path.
// Primary: insert generated .pptx slides into the current deck after the
// currently selected slide. Fallback: no-options insertion. Last resort: open as
// a new presentation so the user never loses generated output.

import { buildDeckPptxBase64 } from "./pptxBuilder.js";

export async function createDeck(spec, styleId, onProgress = () => {}, projectInstructions = "") {
  if (!globalThis.PowerPoint) {
    throw new Error("PowerPoint JavaScript API tidak tersedia di host ini.");
  }
  const slides = Array.isArray(spec?.slides) ? spec.slides : [];
  if (!slides.length) throw new Error("DeckSpec kosong; tidak ada slide untuk dibuat.");

  onProgress(0, slides.length);
  let base64;
  try {
    base64 = buildDeckPptxBase64(spec, styleId, projectInstructions);
  } catch (error) {
    throw new Error(`Gagal menyusun file deck: ${error?.message || error}`);
  }

  // Attempt 1: Insert after current/selected slide using the documented
  // targetSlideId format: selectedSlideID + "#". This should deploy into the
  // same deck at a predictable location.
  try {
    const selectedSlideId = await getSelectedSlideId();
    if (selectedSlideId) {
      await insertBase64(base64, {
        formatting: "KeepSourceFormatting",
        targetSlideId: `${stripHash(selectedSlideId)}#`
      });
      onProgress(slides.length, slides.length);
      return { created: slides.length, total: slides.length, mode: "inserted-after-selected" };
    }
  } catch (targetedError) {
    console.warn("targeted insertSlidesFromBase64 failed; trying no-options insert", targetedError);
  }

  // Attempt 2: Microsoft-documented simplest insertion form.
  try {
    await insertBase64(base64);
    onProgress(slides.length, slides.length);
    return { created: slides.length, total: slides.length, mode: "inserted" };
  } catch (insertError) {
    console.warn("insertSlidesFromBase64 failed; trying createPresentation fallback", insertError);

    // Last resort: open generated deck as a new presentation.
    if (typeof PowerPoint.createPresentation === "function") {
      try {
        await PowerPoint.createPresentation(base64);
        onProgress(slides.length, slides.length);
        return {
          created: slides.length,
          total: slides.length,
          mode: "opened-new-presentation",
          warning: insertError?.message || String(insertError)
        };
      } catch (openError) {
        throw new Error(`Insert ke deck aktif gagal (${insertError?.message || insertError}); fallback buka deck baru juga gagal (${openError?.message || openError}).`);
      }
    }
    throw insertError;
  }
}

async function insertBase64(base64, options) {
  await PowerPoint.run(async (context) => {
    if (options) context.presentation.insertSlidesFromBase64(base64, options);
    else context.presentation.insertSlidesFromBase64(base64);
    await context.sync();
  });
}

function getSelectedSlideId() {
  return new Promise((resolve) => {
    if (!globalThis.Office?.context?.document?.getSelectedDataAsync) {
      resolve("");
      return;
    }
    Office.context.document.getSelectedDataAsync(Office.CoercionType.SlideRange, (asyncResult) => {
      try {
        if (asyncResult.status === Office.AsyncResultStatus.Succeeded) {
          resolve(asyncResult.value?.slides?.[0]?.id || "");
        } else {
          console.warn("Could not get selected slide id", asyncResult.error?.message);
          resolve("");
        }
      } catch (error) {
        console.warn("Could not parse selected slide id", error);
        resolve("");
      }
    });
  });
}

function stripHash(id) {
  return String(id || "").split("#")[0];
}
