package ai.sakana.tantularguard

/**
 * Tantular Guard — Stage 1 on-device risk scorer.
 *
 * This is a direct Kotlin port of the reference Python logic in
 * `godel_agent_prototype/tantular_ondevice_guard.py`, so the Android app and
 * the prototype simulator agree on verdicts.
 *
 * Stage 1 is intentionally rule-based and fully local: no network, no message
 * ever leaves the device. The weights are simple and explainable so the guard
 * stays auditable and cheap. A future stage adds a quantized on-device
 * Tantular SLM for borderline cases (see [modelStubLabel]).
 */
object RiskScorer {

    enum class Verdict { BLOCK, WARN, ALLOW }

    data class GuardVerdict(
        val verdict: Verdict,
        val riskScore: Double,
        val matchedSignals: List<String>,
        val bannerTitle: String,
        val userMessage: String,
        val modelStageUsed: Boolean,
    )

    /** name -> (weight, trigger terms). Kept in sync with the Python reference. */
    private val riskSignals: Map<String, Pair<Double, List<String>>> = mapOf(
        "minta_otp" to (0.45 to listOf("otp", "kode otp", "kode verifikasi", "kode rahasia")),
        "minta_pin_cvv" to (0.45 to listOf("pin", "cvv", "kartu")),
        "minta_password" to (0.35 to listOf("password", "kata sandi", "sandi")),
        "link_mencurigakan" to (0.30 to listOf("http://", "https://", "bit.ly", "wa.me", "klik", "tautan", "link")),
        "apk_mencurigakan" to (0.40 to listOf("apk", ".apk", "install aplikasi", "instal aplikasi", "unduh aplikasi")),
        "remote_access" to (0.40 to listOf("remote", "anydesk", "teamviewer", "akses jarak jauh")),
        "iming_hadiah" to (0.25 to listOf("hadiah", "undian", "menang", "selamat anda")),
        "refund_palsu" to (0.25 to listOf("refund", "pengembalian dana", "dana kembali")),
        "urgensi" to (0.20 to listOf("segera", "sekarang juga", "diblokir", "terblokir", "kadaluarsa", "expired")),
        "mengaku_petugas" to (0.20 to listOf("petugas", "customer service", "cs bank", "admin bank", "pihak bank")),
    )

    private const val BLOCK_THRESHOLD = 0.75
    private const val WARN_THRESHOLD = 0.35

    private val HIGH_RISK = setOf("minta_otp", "minta_pin_cvv", "apk_mencurigakan", "remote_access")

    /** Stage 1 fast scorer: returns (riskScore, matchedSignals). */
    fun score(text: String): Pair<Double, List<String>> {
        val lowered = text.lowercase()
        var score = 0.0
        val matched = mutableListOf<String>()
        for ((name, pair) in riskSignals) {
            val (weight, terms) = pair
            if (terms.any { lowered.contains(it) }) {
                score += weight
                matched.add(name)
            }
        }
        return minOf(score, 1.0) to matched
    }

    /**
     * Stage 2 stub — stand-in for a quantized on-device Tantular verdict.
     * On a real device this becomes a local SLM call; here it is a deterministic
     * label so Stage 1 remains fully offline and testable.
     */
    private fun modelStubLabel(matched: List<String>): String = when {
        matched.any { it in HIGH_RISK } -> "penipuan"
        matched.isNotEmpty() -> "mencurigakan"
        else -> "aman"
    }

    fun evaluate(rawText: String, useModelStage: Boolean = true): GuardVerdict {
        val text = rawText.trim()
        val (score, matched) = score(text)

        var verdict = when {
            score >= BLOCK_THRESHOLD -> Verdict.BLOCK
            score >= WARN_THRESHOLD -> Verdict.WARN
            else -> Verdict.ALLOW
        }

        var modelUsed = false
        if (useModelStage && score >= WARN_THRESHOLD) {
            modelUsed = true
            when (modelStubLabel(matched)) {
                "penipuan" -> verdict = Verdict.BLOCK
                "mencurigakan" -> if (verdict == Verdict.ALLOW) verdict = Verdict.WARN
            }
        }

        val (title, message) = userFacing(verdict)
        return GuardVerdict(
            verdict = verdict,
            riskScore = String.format("%.3f", score).toDouble(),
            matchedSignals = matched,
            bannerTitle = title,
            userMessage = message,
            modelStageUsed = modelUsed,
        )
    }

    private fun userFacing(verdict: Verdict): Pair<String, String> = when (verdict) {
        Verdict.BLOCK -> "\u26A0\uFE0F Peringatan: Indikasi Penipuan" to (
            "Pesan ini kemungkinan besar penipuan. JANGAN bagikan OTP, PIN, CVV, " +
                "atau password; jangan klik link; jangan install APK; jangan beri " +
                "remote access. Hubungi kanal resmi bank/instansi untuk memastikan."
            )
        Verdict.WARN -> "Hati-hati: Pesan Mencurigakan" to (
            "Ada tanda-tanda mencurigakan pada pesan ini. Jangan buru-buru " +
                "mengikuti instruksi, jangan bagikan data pribadi, dan verifikasi " +
                "lewat kanal resmi sebelum bertindak."
            )
        Verdict.ALLOW -> "Tidak ada indikasi bahaya jelas" to (
            "Belum terdeteksi indikator penipuan, tetapi tetap berhati-hati dengan data pribadi."
            )
    }
}
