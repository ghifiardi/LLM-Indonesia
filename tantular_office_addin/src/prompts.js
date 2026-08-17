export const ACTIONS = {
  word_rewrite: {
    label: "Perbaiki bahasa",
    description: "Rapikan ejaan, tata bahasa, dan alur Bahasa Indonesia.",
    hosts: ["Word"],
    maxInputChars: 6000,
    domain: "productivity",
    system: productivitySystem("editor dokumen Word"),
    buildUser: ({ text, instruction }) => `Perbaiki teks berikut dalam Bahasa Indonesia. Pertahankan makna, nama, angka, dan istilah penting. Jika ada campuran Indonesia/English, rapikan secara natural.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nTeks:\n"""${text}"""`
  },
  word_summarize: {
    label: "Ringkas bagian",
    description: "Buat ringkasan singkat dalam bullet Bahasa Indonesia.",
    hosts: ["Word", "PowerPoint"],
    maxInputChars: 10000,
    domain: "productivity",
    system: productivitySystem("peringkas dokumen"),
    buildUser: ({ text, instruction }) => `Ringkas teks berikut dalam Bahasa Indonesia. Jika input berbahasa Inggris, terjemahkan hasilnya ke Bahasa Indonesia. Gunakan 3-7 bullet, jelas, tidak menambah fakta. Format wajib: bullet Markdown yang diawali "- ". Jangan gunakan JSON, array, tanda kurung siku, atau quote pembungkus.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nTeks:\n"""${text}"""`
  },
  scam_check: {
    label: "Cek penipuan",
    description: "Nilai risiko surat/pesan: 🛑, ⚠️, atau ✅ dan beri langkah aman.",
    hosts: ["Word", "Excel", "PowerPoint"],
    maxInputChars: 5000,
    domain: "security",
    system: safetySystem(),
    buildUser: ({ text, instruction }) => `Analisis apakah teks berikut berisiko penipuan/phishing/social engineering.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nTeks:\n"""${text}"""`
  },
  excel_formula_explain: {
    label: "Jelaskan formula",
    description: "Terangkan formula Excel dengan bahasa sederhana.",
    hosts: ["Excel"],
    maxInputChars: 3000,
    domain: "productivity",
    system: productivitySystem("asisten Excel yang hati-hati"),
    buildUser: ({ text, instruction }) => `Jelaskan formula atau isi cell Excel berikut dalam Bahasa Indonesia sederhana. Jika ini bukan formula, jelaskan apa yang bisa disimpulkan dari teksnya. Jangan mengarang hasil hitungan.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nInput:\n"""${text}"""`
  },
  excel_formula_draft: {
    label: "Buat formula sederhana",
    description: "Ubah deskripsi menjadi formula Excel kandidat.",
    hosts: ["Excel"],
    maxInputChars: 2000,
    domain: "productivity",
    system: productivitySystem("asisten formula Excel yang konservatif"),
    buildUser: ({ text, instruction }) => `Buat kandidat formula Excel dari deskripsi berikut. Jawab dengan: Formula, Cara pakai, dan Catatan asumsi. Jangan menjamin formula benar jika range/kolom belum jelas.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nDeskripsi:\n"""${text}"""`
  },
  excel_classify: {
    label: "Klasifikasi risiko per baris",
    description: "Security/anti-fraud: labeli transaksi/pesan 🛑 / ⚠️ / ✅ dengan alasan pendek.",
    hosts: ["Excel"],
    maxInputChars: 12000,
    domain: "security",
    system: safetySystem(),
    buildUser: ({ text, instruction }) => `Klasifikasikan setiap baris teks berikut. Untuk tiap baris, keluarkan satu baris dengan format persis: LABEL | alasan singkat. LABEL harus salah satu dari: 🛑 Risiko tinggi, ⚠️ Perlu dicek, ✅ Aman/normal.\n\nInstruksi tambahan: ${instruction || "Fokus pada risiko penipuan, transaksi mencurigakan, permintaan OTP/PIN/CVV, link/APK, remote access, atau komplain pelanggan."}\n\nBaris:\n${text}`
  },
  ppt_bullets: {
    label: "Paragraf → bullet slide",
    description: "Ubah paragraf panjang menjadi bullet slide yang padat.",
    hosts: ["PowerPoint", "Word"],
    maxInputChars: 5000,
    domain: "productivity",
    system: productivitySystem("penulis slide PowerPoint"),
    buildUser: ({ text, instruction }) => `Ubah teks berikut menjadi 3-6 bullet slide Bahasa Indonesia yang ringkas. Jika input berbahasa Inggris, terjemahkan hasilnya ke Bahasa Indonesia. Format wajib: bullet Markdown yang diawali "- ". Hindari kalimat terlalu panjang. Jangan gunakan JSON, array, tanda kurung siku, atau quote pembungkus.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nTeks:\n"""${text}"""`
  },
  ppt_notes: {
    label: "Draft speaker notes",
    description: "Buat catatan pembicara dari teks slide.",
    hosts: ["PowerPoint"],
    maxInputChars: 5000,
    domain: "productivity",
    system: productivitySystem("pembuat speaker notes"),
    buildUser: ({ text, instruction }) => `Buat speaker notes Bahasa Indonesia untuk slide berikut. Jika input berbahasa Inggris, terjemahkan hasilnya ke Bahasa Indonesia. Gunakan gaya natural, 45-90 detik bicara, dan jangan menambah fakta baru. Jangan gunakan JSON atau array; tulis sebagai paragraf/catatan pembicara yang siap dibaca.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nTeks slide:\n"""${text}"""`
  },
  text_cleanup: {
    label: "Bersihkan teks",
    description: "Standarkan kapitalisasi, spasi, sapaan, alamat, atau nama.",
    hosts: ["Word", "Excel", "PowerPoint"],
    maxInputChars: 7000,
    domain: "productivity",
    system: productivitySystem("editor data teks Indonesia"),
    buildUser: ({ text, instruction }) => `Bersihkan dan standarkan teks berikut dalam Bahasa Indonesia yang natural bila konteksnya presentasi/dokumen Indonesia. Pertahankan data penting seperti nama, nomor, alamat, tanggal, dan jumlah uang.\n\nInstruksi tambahan: ${instruction || "Rapikan kapitalisasi, spasi, tanda baca, dan format umum Bahasa Indonesia."}\n\nTeks:\n"""${text}"""`
  }
};

export function actionsForHost(hostName) {
  const normalized = normalizeHostName(hostName);
  return Object.entries(ACTIONS)
    .filter(([, action]) => action.hosts.includes(normalized))
    .map(([id, action]) => ({ id, ...action }));
}

export function normalizeHostName(hostName) {
  const value = String(hostName || "").toLowerCase();
  if (value.includes("word")) return "Word";
  if (value.includes("excel")) return "Excel";
  if (value.includes("powerpoint")) return "PowerPoint";
  if (value.includes("outlook")) return "Outlook";
  return "Office";
}

// Office.onReady's `info.host` is not always populated — it has been observed
// empty on Mac hosts — and normalizeHostName then answers "Office". That is not
// a cosmetic label: "Office" fails the Word/Excel/PowerPoint gate that mounts
// the agentic chat pane, AND hostUi gives it deckStudio:false, so the chat and
// Deck Studio cards both silently never appear while every host-agnostic
// section renders normally. The pane looks stripped rather than broken.
//
// So never trust one source. Fall back to Office.context.host, then to the
// host-specific globals Office.js injects (PowerPoint/Word/Excel namespaces),
// then to the requirement sets. Any one of them identifying the host is enough.
export function detectHost(readyInfo, globals = globalThis) {
  const fromReady = normalizeHostName(readyInfo?.host);
  if (fromReady !== "Office") return fromReady;

  const fromContext = normalizeHostName(globals?.Office?.context?.host);
  if (fromContext !== "Office") return fromContext;

  // Office.js only defines these namespaces in the host they belong to.
  if (typeof globals?.PowerPoint !== "undefined") return "PowerPoint";
  if (typeof globals?.Excel !== "undefined") return "Excel";
  if (typeof globals?.Word !== "undefined") return "Word";

  const supported = globals?.Office?.context?.requirements?.isSetSupported;
  if (typeof supported === "function") {
    if (supported.call(null, "PowerPointApi", "1.1")) return "PowerPoint";
    if (supported.call(null, "ExcelApi", "1.1")) return "Excel";
    if (supported.call(null, "WordApi", "1.1")) return "Word";
  }
  return "Office";
}

export function scopedUserPrompt(action, userPrompt) {
  const domain = action?.domain === "security" ? "security" : "productivity";
  const scope = domain === "security"
    ? [
      "SCOPE AKTIF: SECURITY / ANTI-FRAUD.",
      "Kerjakan sebagai analisis keamanan/fraud karena aksi yang dipilih memang aksi keamanan.",
      "Tetap source-grounded: jangan menambah indikator risiko yang tidak didukung input."
    ]
    : [
      "SCOPE AKTIF: OFFICE PRODUCTIVITY.",
      "Kerjakan sebagai tugas produktivitas Office, bukan analisis scam/spam/cybersecurity.",
      "Jangan menolak karena topik bukan keamanan. Jangan mengubah output menjadi penilaian fraud/compliance kecuali instruksi eksplisit memintanya.",
      "Jika kata risk/risiko muncul, perlakukan sesuai konteks dokumen yang diberikan, bukan otomatis risiko cyber."
    ];
  return `${scope.join("\n")}\n\n${userPrompt}`;
}

function productivitySystem(role) {
  return [
    `Anda adalah Tantular Office Productivity, ${role} yang privat dan Indonesian-first.`,
    "Mode aktif: PRODUKTIVITAS OFFICE, bukan mode keamanan/fraud.",
    "Tugas utama: membantu menulis, merapikan, meringkas, menjelaskan, membuat formula, bullet slide, speaker notes, dan struktur dokumen/presentasi.",
    "JANGAN menolak atau menilai sesuatu sebagai di luar scope hanya karena tidak terkait scam/spam/cybersecurity.",
    "JANGAN mengubah tugas produktivitas menjadi analisis keamanan, anti-fraud, phishing, scam, atau compliance kecuali pengguna eksplisit memintanya atau input jelas meminta penilaian risiko keamanan.",
    "Jika ada konten yang bersinggungan dengan risiko/security, perlakukan sebagai konten dokumen biasa kecuali aksi yang dipilih adalah Cek penipuan/Klasifikasi risiko.",
    "SELALU jawab dalam Bahasa Indonesia yang jelas, singkat, dan bermanfaat, walaupun input berbahasa Inggris.",
    "Terjemahkan istilah Inggris ke Indonesia bila natural, tetapi pertahankan istilah teknis umum seperti cloud, firewall, SIEM, dan AI bila perlu.",
    "Jangan mengarang fakta. Jika input kurang jelas, sebutkan asumsi secara ringkas.",
    "Pertahankan data penting seperti angka, nama, tanggal, nomor rekening/order, dan istilah teknis.",
    "Jangan gunakan JSON atau array kecuali pengguna secara eksplisit memintanya."
  ].join(" ");
}

function safetySystem() {
  return [
    "Anda adalah Tantular Security & Anti-Fraud, asisten keamanan Bahasa Indonesia.",
    "Mode aktif: KEAMANAN / ANTI-FRAUD.",
    "Tugas utama: mengenali penipuan, phishing, social engineering, surat palsu, invoice palsu, permintaan OTP/PIN/CVV/password, link mencurigakan, APK, remote access, dan transaksi/pesan mencurigakan.",
    "Gunakan mode ini hanya untuk aksi keamanan seperti Cek penipuan atau Klasifikasi risiko.",
    "Jika ada indikator tinggi, beri label 🛑 Risiko tinggi dan instruksi tegas: jangan bagikan OTP/PIN/CVV/password, jangan klik link/install APK, jangan beri remote access, simpan bukti, dan hubungi kanal resmi.",
    "Jika tidak pasti, beri ⚠️ Perlu dicek. Jangan meminta data sensitif dari pengguna."
  ].join(" ");
}
