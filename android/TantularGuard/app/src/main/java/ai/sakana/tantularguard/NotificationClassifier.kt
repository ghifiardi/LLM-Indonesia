package ai.sakana.tantularguard

import java.util.Locale

/**
 * Consumer Message Assistant Cluster D: classify a notification into an everyday
 * category for the on-device daily digest.
 *
 * Deterministic Kotlin port of `classify_notification` in tantular_assistant.py.
 * Keep the signal lists and match order in sync with that reference.
 */
object NotificationClassifier {

    data class Category(
        val key: String,
        val emoji: String,
        val label: String,
        val priority: String, // tinggi | sedang | rendah
    )

    /** key -> emoji + label. Also the digest DISPLAY order. */
    private val CATEGORIES = listOf(
        Triple("keamanan_akun", "🔐", "Keamanan akun"),
        Triple("keuangan", "💰", "Keuangan"),
        Triple("paket", "📦", "Paket"),
        Triple("kesehatan", "🏥", "Kesehatan"),
        Triple("travel", "✈️", "Travel"),
        Triple("sekolah", "🏫", "Sekolah"),
        Triple("kerja", "💼", "Kerja"),
        Triple("keluarga", "👨‍👩‍👧", "Keluarga"),
        Triple("promo", "🎁", "Promo"),
        Triple("umum", "🔔", "Umum"),
    )

    /** Display order of categories in the digest UI. */
    val ORDER: List<String> = CATEGORIES.map { it.first }

    /** Hidden by the "Penting saja" (important-only) filter. */
    val UNIMPORTANT: Set<String> = setOf("promo", "umum")

    private val EMOJI = CATEGORIES.associate { it.first to it.second }
    private val LABEL = CATEGORIES.associate { it.first to it.third }

    fun emoji(key: String): String = EMOJI[key] ?: "🔔"
    fun label(key: String): String = LABEL[key] ?: key

    // Brand names (gopay/bca/jne) are intentionally NOT signals: the app label
    // already carries the brand, and brand-in-text misfiles promos as finance.
    private val SIGNALS = mapOf(
        "keamanan_akun" to listOf("otp", "kode verifikasi", "kode login", "kode masuk", "verifikasi", "perangkat tertaut", "linked device", "kata sandi", "login", "one-time"),
        "paket" to listOf("paket", "resi", "kurir", "dikirim", "pengiriman", "cod", "pesanan", "akan tiba", "out for delivery", "dalam perjalanan", "sedang dikirim"),
        "kesehatan" to listOf("dokter", "klinik", "rumah sakit", "obat", "kontrol", "resep", "vaksin", "antrian", "bpjs kesehatan"),
        "travel" to listOf("tiket", "booking", "hotel", "pesawat", "penerbangan", "boarding", "check-in", "kereta", "stasiun", "bandara", "reservasi"),
        "sekolah" to listOf("sekolah", "kelas", "guru", "siswa", "orang tua", "kampus", "kuliah", "ujian", "spp", "wali kelas"),
        "kerja" to listOf("meeting", "rapat", "interview", "wawancara", "kantor", "deadline", "proyek", "lembur", "absensi", "slip gaji", "shift"),
        "keuangan" to listOf("transaksi", "transfer", "saldo", "top up", "topup", "pembayaran", "pembelian", "qris", "debit", "kredit", "mutasi", "rekening", "e-wallet", "tagihan", "jatuh tempo", "angsuran", "cicilan", "pln", "listrik", "pulsa", "virtual account", "biaya admin"),
        "promo" to listOf("promo", "diskon", "cashback", "voucher", "flash sale", "gratis", "kupon", "sale", "gratis ongkir"),
        "keluarga" to listOf("keluarga", "grup keluarga", "family"),
    )

    // Specific institutions before the broad "keuangan"; promo after; umum fallback.
    private val MATCH_ORDER = listOf(
        "keamanan_akun", "paket", "kesehatan", "travel", "sekolah", "kerja", "keuangan", "promo", "keluarga",
    )
    private val HIGH = listOf("segera", "jatuh tempo", "deadline", "terakhir", "expired", "kadaluarsa", "diblokir", "sekarang juga")

    fun classify(text: String?, title: String? = null): Category {
        val blob = "${title.orEmpty()} ${text.orEmpty()}".lowercase(Locale.ROOT)
        var key = "umum"
        for (cand in MATCH_ORDER) {
            if (hasAny(blob, SIGNALS.getValue(cand))) {
                key = cand
                break
            }
        }
        val priority = when {
            key == "keamanan_akun" || hasAny(blob, HIGH) -> "tinggi"
            key == "promo" || key == "keluarga" || key == "umum" -> "rendah"
            else -> "sedang"
        }
        return Category(key, emoji(key), label(key), priority)
    }

    private fun hasAny(blob: String, terms: List<String>): Boolean = terms.any { blob.contains(it) }
}
