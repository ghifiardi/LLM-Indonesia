export const ACTIONS = {
  word_rewrite: {
    label: "Perbaiki bahasa",
    description: "Rapikan ejaan, tata bahasa, dan alur Bahasa Indonesia.",
    hosts: ["Word"],
    maxInputChars: 6000,
    system: baseSystem("editor dokumen Word"),
    buildUser: ({ text, instruction }) => `Perbaiki teks berikut dalam Bahasa Indonesia. Pertahankan makna, nama, angka, dan istilah penting. Jika ada campuran Indonesia/English, rapikan secara natural.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nTeks:\n"""${text}"""`
  },
  word_summarize: {
    label: "Ringkas bagian",
    description: "Buat ringkasan singkat dalam bullet Bahasa Indonesia.",
    hosts: ["Word", "PowerPoint"],
    maxInputChars: 10000,
    system: baseSystem("peringkas dokumen"),
    buildUser: ({ text, instruction }) => `Ringkas teks berikut dalam Bahasa Indonesia. Jika input berbahasa Inggris, terjemahkan hasilnya ke Bahasa Indonesia. Gunakan 3-7 bullet, jelas, tidak menambah fakta. Format wajib: bullet Markdown yang diawali "- ". Jangan gunakan JSON, array, tanda kurung siku, atau quote pembungkus.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nTeks:\n"""${text}"""`
  },
  scam_check: {
    label: "Cek penipuan",
    description: "Nilai risiko surat/pesan: 🛑, ⚠️, atau ✅ dan beri langkah aman.",
    hosts: ["Word", "Excel", "PowerPoint"],
    maxInputChars: 5000,
    system: safetySystem(),
    buildUser: ({ text, instruction }) => `Analisis apakah teks berikut berisiko penipuan/phishing/social engineering.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nTeks:\n"""${text}"""`
  },
  excel_formula_explain: {
    label: "Jelaskan formula",
    description: "Terangkan formula Excel dengan bahasa sederhana.",
    hosts: ["Excel"],
    maxInputChars: 3000,
    system: baseSystem("asisten Excel yang hati-hati"),
    buildUser: ({ text, instruction }) => `Jelaskan formula atau isi cell Excel berikut dalam Bahasa Indonesia sederhana. Jika ini bukan formula, jelaskan apa yang bisa disimpulkan dari teksnya. Jangan mengarang hasil hitungan.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nInput:\n"""${text}"""`
  },
  excel_formula_draft: {
    label: "Buat formula sederhana",
    description: "Ubah deskripsi menjadi formula Excel kandidat.",
    hosts: ["Excel"],
    maxInputChars: 2000,
    system: baseSystem("asisten formula Excel yang konservatif"),
    buildUser: ({ text, instruction }) => `Buat kandidat formula Excel dari deskripsi berikut. Jawab dengan: Formula, Cara pakai, dan Catatan asumsi. Jangan menjamin formula benar jika range/kolom belum jelas.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nDeskripsi:\n"""${text}"""`
  },
  excel_classify: {
    label: "Klasifikasi teks per baris",
    description: "Labeli transaksi/pesan pelanggan: 🛑 / ⚠️ / ✅ dengan alasan pendek.",
    hosts: ["Excel"],
    maxInputChars: 12000,
    system: safetySystem(),
    buildUser: ({ text, instruction }) => `Klasifikasikan setiap baris teks berikut. Untuk tiap baris, keluarkan satu baris dengan format persis: LABEL | alasan singkat. LABEL harus salah satu dari: 🛑 Risiko tinggi, ⚠️ Perlu dicek, ✅ Aman/normal.\n\nInstruksi tambahan: ${instruction || "Fokus pada risiko penipuan, transaksi mencurigakan, permintaan OTP/PIN/CVV, link/APK, remote access, atau komplain pelanggan."}\n\nBaris:\n${text}`
  },
  ppt_bullets: {
    label: "Paragraf → bullet slide",
    description: "Ubah paragraf panjang menjadi bullet slide yang padat.",
    hosts: ["PowerPoint", "Word"],
    maxInputChars: 5000,
    system: baseSystem("penulis slide PowerPoint"),
    buildUser: ({ text, instruction }) => `Ubah teks berikut menjadi 3-6 bullet slide Bahasa Indonesia yang ringkas. Jika input berbahasa Inggris, terjemahkan hasilnya ke Bahasa Indonesia. Format wajib: bullet Markdown yang diawali "- ". Hindari kalimat terlalu panjang. Jangan gunakan JSON, array, tanda kurung siku, atau quote pembungkus.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nTeks:\n"""${text}"""`
  },
  ppt_notes: {
    label: "Draft speaker notes",
    description: "Buat catatan pembicara dari teks slide.",
    hosts: ["PowerPoint"],
    maxInputChars: 5000,
    system: baseSystem("pembuat speaker notes"),
    buildUser: ({ text, instruction }) => `Buat speaker notes Bahasa Indonesia untuk slide berikut. Jika input berbahasa Inggris, terjemahkan hasilnya ke Bahasa Indonesia. Gunakan gaya natural, 45-90 detik bicara, dan jangan menambah fakta baru. Jangan gunakan JSON atau array; tulis sebagai paragraf/catatan pembicara yang siap dibaca.\n\nInstruksi tambahan: ${instruction || "tidak ada"}\n\nTeks slide:\n"""${text}"""`
  },
  text_cleanup: {
    label: "Bersihkan teks",
    description: "Standarkan kapitalisasi, spasi, sapaan, alamat, atau nama.",
    hosts: ["Word", "Excel", "PowerPoint"],
    maxInputChars: 7000,
    system: baseSystem("editor data teks Indonesia"),
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

function baseSystem(role) {
  return `Anda adalah Tantular, ${role} yang privat dan Indonesian-first. SELALU jawab dalam Bahasa Indonesia yang jelas, singkat, dan bermanfaat, walaupun input berbahasa Inggris. Terjemahkan istilah Inggris ke Indonesia bila natural, tetapi pertahankan istilah teknis umum seperti cloud, firewall, SIEM, dan AI bila perlu. Jangan mengarang fakta. Jika input kurang jelas, sebutkan asumsi. Pertahankan data penting seperti angka, nama, tanggal, nomor rekening/order, dan istilah teknis. Jangan gunakan JSON atau array kecuali pengguna secara eksplisit memintanya.`;
}

function safetySystem() {
  return `Anda adalah Tantular, asisten keamanan Bahasa Indonesia. Tugas utama: mengenali penipuan, phishing, social engineering, surat palsu, invoice palsu, permintaan OTP/PIN/CVV/password, link mencurigakan, APK, atau remote access. Jika ada indikator tinggi, beri label 🛑 Risiko tinggi dan instruksi tegas: jangan bagikan OTP/PIN/CVV/password, jangan klik link/install APK, jangan beri remote access, simpan bukti, dan hubungi kanal resmi. Jika tidak pasti, beri ⚠️ Perlu dicek. Jangan meminta data sensitif dari pengguna.`;
}
