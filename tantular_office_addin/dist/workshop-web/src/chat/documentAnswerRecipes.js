export function isClosedVsOpenWeightTopic(instruction, contextText = "") {
  const value = `${instruction || ""}\n${contextText || ""}`.toLowerCase();
  return /closed\s+model/.test(value) && /open[-\s]?weight/.test(value);
}

export function closedVsOpenWeightElaboration() {
  return [
    "### Closed Model vs. Open-Weight: Memahami Perbedaan",
    "",
    "**Closed model** biasanya diakses melalui aplikasi atau API milik penyedia. Bobot model tidak diberikan kepada pengguna, sementara penyedia mengelola infrastruktur, pembaruan, dan sebagian besar operasi model.",
    "",
    "**Open-weight** berarti bobot model tersedia untuk digunakan sesuai lisensinya. Organisasi dapat menjalankan model di infrastruktur sendiri dan, bila lisensi serta teknologinya memungkinkan, melakukan fine-tuning. Namun, open-weight **tidak otomatis berarti open-source penuh**: kode pelatihan, data latih, proses evaluasi, dan detail arsitektur dapat tetap tertutup.",
    "",
    "#### Dimensi perbandingan",
    "- **Deployment dan data:** closed model umumnya berjalan di lingkungan penyedia; open-weight dapat dijalankan on-premise atau pada cloud yang dipilih organisasi. Lokasi deployment membantu kendali data, tetapi keamanan tetap bergantung pada arsitektur dan tata kelola.",
    "- **Kustomisasi:** closed model dibatasi fitur dan API yang tersedia. Open-weight memberi ruang lebih besar untuk fine-tuning, optimasi, serta integrasi khusus.",
    "- **Vendor lock-in dan exit plan:** closed model dapat membuat perpindahan lebih sulit jika aplikasi bergantung pada API proprietari. Open-weight memberi opsi portabilitas yang lebih besar, tetapi organisasi tetap harus memeriksa lisensi, format model, dan kompatibilitas infrastrukturnya.",
    "- **Operasi dan talenta:** closed model mengurangi beban pengelolaan model. Open-weight memindahkan lebih banyak tanggung jawab kepada organisasi, termasuk deployment, monitoring, patching, evaluasi, dan keamanan.",
    "- **Biaya:** closed model biasanya ringan di awal tetapi biaya bertambah bersama pemakaian. Open-weight membutuhkan investasi awal pada komputasi dan talenta; manfaat ekonominya bergantung pada skala dan pola penggunaan.",
    "- **Keamanan dan privasi:** tidak ada pendekatan yang otomatis lebih aman. Closed model bergantung pada kontrol penyedia dan perjanjian pemrosesan data; open-weight memberi kendali lebih besar tetapi juga menambah tanggung jawab keamanan kepada pengelola.",
    "",
    "#### Kriteria pemilihan",
    "Gunakan closed model ketika kecepatan implementasi dan layanan terkelola lebih penting. Pertimbangkan open-weight ketika data sensitif, kebutuhan on-premise, kustomisasi, atau exit plan menjadi prioritas dan organisasi memiliki kapasitas teknis yang memadai.",
    "",
    "Untuk ekosistem AI Indonesia, pendekatan yang realistis bukan memilih salah satu untuk semua kebutuhan, melainkan membangun **portofolio**: gunakan layanan closed untuk eksperimen cepat, sambil membangun opsi open-weight untuk layanan kritikal, data sensitif, dan kedaulatan jangka panjang."
  ].join("\n");
}

export function closedVsOpenWeightEdit(contextText) {
  const paragraphs = String(contextText || "").split(/\n+/).map((item) => item.trim()).filter(Boolean);
  const candidate = paragraphs.find((item) =>
    /closed model dan open-weight/i.test(item) && item.length <= 200
  ) || paragraphs.find((item) => /closed model dan open-weight/i.test(item));
  if (!candidate) return null;

  const firstSentence = candidate.match(/^.{20,200}?\.(?:\s|$)/)?.[0]?.trim();
  const find = candidate.length <= 200 ? candidate : firstSentence;
  if (!find) return null;

  const body = closedVsOpenWeightElaboration()
    .replace(/^### .+\n\n/, "")
    .replace(/\n#### Dimensi perbandingan\n/, "\n\nDimensi perbandingan:\n")
    .replace(/\n#### Kriteria pemilihan\n/, "\n\nKriteria pemilihan:\n")
    .replace(/\*\*/g, "")
    .replace(/^- /gm, "• ");

  return {
    find,
    replace: `${find}\n\n${body}`,
    before: "",
    after: "",
    occurrence: 1,
    alasan: "Memperluas subbagian dengan definisi, trade-off, risiko, dan kriteria pemilihan yang lebih akurat."
  };
}
