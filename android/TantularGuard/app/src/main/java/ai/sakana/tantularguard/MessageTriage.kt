package ai.sakana.tantularguard

import java.util.Locale
import java.util.regex.Pattern

/** Consumer Message Assistant Cluster B: deterministic triage + extraction. */
object MessageTriage {
    data class ExtractedItem(val kind: String, val label: String, val value: String)
    data class Result(
        val category: String,
        val categoryLabel: String,
        val priority: String,
        val priorityLabel: String,
        val summary: String,
        val actions: List<String>,
        val items: List<ExtractedItem>,
    )

    private val amountRe = Pattern.compile("""(?i)(rp\s?\d[\d\.,]*|idr\s?\d[\d\.,]*|\d[\d\.,]*\s?rupiah)""")
    private val dateRe = Pattern.compile("""(?i)(\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b|\b\d{1,2}\s?(jan|feb|mar|apr|mei|jun|jul|agu|agustus|sep|okt|nov|des)\w*\b|hari ini|besok|lusa|minggu ini|bulan ini)""")
    private val codeRe = Pattern.compile("""(?i)\b(order|pesanan|resi|invoice|inv|booking)[:#\s-]*([A-Z0-9-]{5,})""")

    private val categoryLabels = mapOf(
        "keamanan_akun" to "Keamanan akun",
        "penipuan" to "Risiko penipuan",
        "tagihan" to "Tagihan / pembayaran",
        "promo" to "Promo / penawaran",
        "paket" to "Pengiriman / paket",
        "jadwal" to "Jadwal / pertemuan",
        "kerja" to "Kerja / HR",
        "sekolah" to "Sekolah / keluarga",
        "umum" to "Pesan umum",
    )
    private val priorityLabels = mapOf("tinggi" to "Penting", "sedang" to "Perlu dicek", "rendah" to "Biasa")

    fun analyze(text: String?, verdict: RiskScorer.GuardVerdict? = null): Result {
        val raw = text.orEmpty().trim()
        val lower = raw.lowercase(Locale.ROOT)
        val items = extractItems(raw)
        val cat = category(lower, verdict)
        val prio = priority(lower, cat, items, verdict)
        val acts = actions(cat, prio, verdict)
        val key = firstSentence(raw)
        val itemText = if (items.isNotEmpty()) {
            " Info penting: " + items.take(3).joinToString("; ") { "${it.label}: ${it.value}" } + "."
        } else ""
        val riskText = verdict?.let { " Hasil keamanan: ${it.verdict.name}." } ?: ""
        val summary = "Kategori: ${categoryLabels[cat]}. Prioritas: ${priorityLabels[prio]}. Intinya: $key.$itemText$riskText"
        return Result(cat, categoryLabels[cat] ?: cat, prio, priorityLabels[prio] ?: prio, summary, acts, items)
    }

    private fun extractItems(text: String): List<ExtractedItem> {
        val out = mutableListOf<ExtractedItem>()
        val amount = amountRe.matcher(text)
        while (amount.find()) out += ExtractedItem("amount", "Nominal", amount.group().trim())
        val date = dateRe.matcher(text)
        while (date.find()) out += ExtractedItem("date", "Tanggal/batas waktu", date.group().trim())
        val code = codeRe.matcher(text)
        while (code.find()) {
            val label = code.group(1)?.uppercase(Locale.ROOT) ?: "KODE"
            val value = code.group(2) ?: code.group()
            out += ExtractedItem("code", label, value)
        }
        return out.distinctBy { Triple(it.kind, it.label, it.value.lowercase(Locale.ROOT)) }.take(6)
    }

    private fun category(lower: String, verdict: RiskScorer.GuardVerdict?): String {
        if (verdict?.accountTakeover == true || hasAny(lower, "otp", "kode verifikasi", "kode login", "perangkat tertaut", "linked device", "reset password", "akun diblokir")) return "keamanan_akun"
        if (verdict?.verdict == RiskScorer.Verdict.BLOCK || hasAny(lower, "penipuan", "apk", "anydesk", "teamviewer", "remote access")) return "penipuan"
        if (hasAny(lower, "tagihan", "jatuh tempo", "bayar", "pembayaran", "invoice", "bpjs", "listrik", "pln", "internet", "angsuran", "cicilan", "sewa")) return "tagihan"
        if (hasAny(lower, "promo", "diskon", "voucher", "cashback", "gratis", "flash sale", "undian", "hadiah")) return "promo"
        if (hasAny(lower, "paket", "kurir", "resi", "dikirim", "pengiriman", "cod", "ambil paket")) return "paket"
        if (hasAny(lower, "meeting", "rapat", "jadwal", "appointment", "janji", "wawancara", "interview", "kontrol", "dokter", "besok", "lusa")) return "jadwal"
        if (hasAny(lower, "hr", "rekrut", "lamaran", "kandidat", "kantor", "kerja")) return "kerja"
        if (hasAny(lower, "sekolah", "kampus", "guru", "kelas", "siswa", "orang tua")) return "sekolah"
        return "umum"
    }

    private fun priority(lower: String, category: String, items: List<ExtractedItem>, verdict: RiskScorer.GuardVerdict?): String = when {
        verdict?.verdict == RiskScorer.Verdict.BLOCK || verdict?.accountTakeover == true || hasAny(lower, "segera", "sekarang", "diblokir", "jatuh tempo", "deadline", "terakhir", "expired", "kadaluarsa") -> "tinggi"
        items.any { it.kind == "date" } || category in setOf("tagihan", "paket", "jadwal") -> "sedang"
        else -> "rendah"
    }

    private fun actions(category: String, priority: String, verdict: RiskScorer.GuardVerdict?): List<String> {
        if (verdict?.verdict == RiskScorer.Verdict.BLOCK || verdict?.accountTakeover == true || category in setOf("keamanan_akun", "penipuan")) {
            return listOf("Jangan klik tautan, jangan kirim kode/OTP, dan jangan install aplikasi.", "Cek langsung lewat aplikasi atau kanal resmi.")
        }
        return when (category) {
            "tagihan" -> listOf("Cek tagihan di aplikasi resmi sebelum membayar.", "Simpan atau buat pengingat bila ada batas waktu.")
            "promo" -> listOf("Cek masa berlaku dan syarat promo.", "Jangan kirim data sensitif untuk klaim promo.")
            "paket" -> listOf("Cek nomor resi di aplikasi resmi atau situs kurir.", "Pastikan nominal COD sesuai pesanan.")
            "jadwal" -> listOf("Buat pengingat agar tidak terlewat.", "Balas konfirmasi jika pengirimnya jelas.")
            else -> if (priority == "tinggi") listOf("Periksa segera lewat kanal resmi sebelum bertindak.") else listOf("Tidak ada tindakan khusus. Simpan pesan jika diperlukan.")
        }
    }

    private fun firstSentence(text: String): String =
        text.split('.', '\n').firstOrNull()?.trim()?.ifBlank { text.take(140) } ?: "Pesan kosong"

    private fun hasAny(lower: String, vararg terms: String): Boolean = terms.any { lower.contains(it) }
}
