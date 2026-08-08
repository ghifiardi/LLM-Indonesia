export function hostUiConfig(hostName) {
  const host = String(hostName || "");
  if (host === "Excel") {
    return {
      documentStudio: false,
      sheetStudio: true,
      deckStudio: false,
      deckRefine: false,
      actionsTitle: "Aksi cepat Excel",
      actionWarning: "Untuk membuat workbook lengkap, gunakan <strong>📊 Sheet Studio</strong> di atas. Aksi cepat hanya memproses cell/range atau teks sumber.",
      insertLabel: "Masukkan ke cell/range"
    };
  }
  if (host === "Word") {
    return {
      documentStudio: true,
      sheetStudio: false,
      deckStudio: false,
      deckRefine: false,
      actionsTitle: "Aksi cepat Word",
      actionWarning: "Untuk membuat dokumen lengkap, gunakan <strong>📄 Document Studio</strong> di atas. Aksi cepat hanya memproses seleksi atau teks sumber.",
      insertLabel: "Masukkan ke dokumen"
    };
  }
  if (host === "PowerPoint") {
    return {
      documentStudio: false,
      sheetStudio: false,
      deckStudio: true,
      deckRefine: true,
      actionsTitle: "Aksi cepat PowerPoint",
      actionWarning: "Untuk membuat presentasi lengkap, gunakan <strong>✨ Deck Studio</strong> di atas. Aksi cepat hanya merapikan atau meringkas teks slide.",
      insertLabel: "Masukkan ke slide"
    };
  }
  return {
    documentStudio: false,
    sheetStudio: false,
    deckStudio: false,
    deckRefine: false,
    actionsTitle: "Aksi cepat",
    actionWarning: "Aksi cepat bekerja pada teks atau seleksi aktif.",
    insertLabel: "Masukkan hasil"
  };
}
