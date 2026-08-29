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

    private val PERSONAL_MESSAGE_PACKAGES = setOf(
        "com.whatsapp",
        "com.whatsapp.w4b",
        "org.telegram.messenger",
        "com.facebook.orca",
    )

    // Brand names (gopay/bca/jne) are intentionally NOT signals: the app label
    // already carries the brand, and brand-in-text misfiles promos as finance.
    //
    // Signals are matched on WORD BOUNDARIES (see [hasAny]) so short tokens like
    // "cod" no longer misfire inside unrelated words such as "coding". Only add
    // bare tokens here when they are unambiguous on their own; otherwise prefer a
    // multi-word phrase (e.g. "kode login" instead of "login").
    private val SIGNALS = mapOf(
        "keamanan_akun" to listOf("otp", "kode otp", "kode verifikasi", "kode login", "kode masuk", "kode akses", "perangkat tertaut", "linked device", "kata sandi", "one-time", "verification code", "login code", "reset password", "password reset", "reset your password", "atur ulang kata sandi", "ubah kata sandi"),
        "paket" to listOf("paket", "resi", "kurir", "dikirim", "pengiriman", "cod", "pesanan", "akan tiba", "out for delivery", "dalam perjalanan", "sedang dikirim", "bea cukai"),
        "kesehatan" to listOf("dokter", "klinik", "rumah sakit", "obat", "kontrol", "resep", "vaksin", "antrian", "bpjs kesehatan"),
        "travel" to listOf("tiket", "booking", "hotel", "pesawat", "penerbangan", "boarding", "check-in", "kereta", "stasiun", "bandara", "reservasi"),
        "sekolah" to listOf("sekolah", "kelas", "guru", "siswa", "orang tua", "kampus", "kuliah", "ujian", "spp", "wali kelas"),
        "kerja" to listOf("meeting", "rapat", "interview", "wawancara", "kantor", "deadline", "proyek", "lembur", "absensi", "slip gaji", "shift"),
        "keuangan" to listOf("transaksi", "transfer", "saldo", "top up", "topup", "pembayaran", "pembelian", "qris", "debit", "kredit", "mutasi", "rekening", "e-wallet", "tagihan", "jatuh tempo", "angsuran", "cicilan", "pln", "listrik", "pulsa", "virtual account", "biaya admin"),
        "promo" to listOf("promo", "diskon", "cashback", "voucher", "flash sale", "gratis", "kupon", "sale", "gratis ongkir"),
        "keluarga" to listOf("keluarga", "grup keluarga", "family"),
    )

    // Precompiled word-boundary matchers per signal. A "word" char is a Unicode
    // letter or digit; hyphens/spaces inside a phrase are literal. This makes
    // "cod" match only the standalone word, never "coding".
    private val MATCHERS: Map<String, List<Regex>> = SIGNALS.mapValues { (_, terms) ->
        terms.map { term ->
            Regex("(?<![\\p{L}\\p{N}])" + Regex.escape(term) + "(?![\\p{L}\\p{N}])", RegexOption.IGNORE_CASE)
        }
    }

    // Specific institutions before the broad "keuangan"; promo after; umum fallback.
    private val MATCH_ORDER = listOf(
        "keamanan_akun", "paket", "kesehatan", "travel", "sekolah", "kerja", "keuangan", "promo", "keluarga",
    )
    private val HIGH = listOf("segera", "jatuh tempo", "deadline", "terakhir", "expired", "kadaluarsa", "diblokir", "sekarang juga")

    fun classify(text: String?, title: String? = null): Category {
        val blob = "${title.orEmpty()} ${text.orEmpty()}"
        var key = "umum"
        for (cand in MATCH_ORDER) {
            if (hasAny(blob, cand)) {
                key = cand
                break
            }
        }
        val priority = when {
            key == "keamanan_akun" || hasAnyRaw(blob, HIGH) -> "tinggi"
            key == "promo" || key == "keluarga" || key == "umum" -> "rendah"
            else -> "sedang"
        }
        return Category(key, emoji(key), label(key), priority)
    }

    /**
     * Digest is not a raw notification log. Keep useful categories, but suppress
     * generic group-chat chatter like "makasi pak" / "done ya" that otherwise
     * floods "Umum". One-to-one messenger messages can stay; non-messenger umum
     * is usually system/app noise and is dropped.
     */
    fun shouldKeepForDigest(packageName: String, title: String?, category: String): Boolean {
        if (category != "umum") return true
        if (packageName !in PERSONAL_MESSAGE_PACKAGES) return false
        return !looksLikeGroupBatch(title.orEmpty())
    }

    private fun hasAny(blob: String, category: String): Boolean =
        MATCHERS.getValue(category).any { it.containsMatchIn(blob) }

    private fun hasAnyRaw(blob: String, terms: List<String>): Boolean {
        val lowered = blob.lowercase(Locale.ROOT)
        return terms.any { lowered.contains(it) }
    }

    private fun looksLikeGroupBatch(title: String): Boolean =
        Regex("""\(\d+\s+pesan\)""", RegexOption.IGNORE_CASE).containsMatchIn(title) ||
            Regex("""\(\d+\s+messages\)""", RegexOption.IGNORE_CASE).containsMatchIn(title)
}
