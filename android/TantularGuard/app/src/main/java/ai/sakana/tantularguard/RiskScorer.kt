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
        val slmLabel: SlmLabel? = null,
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

    internal val HIGH_RISK = setOf("minta_otp", "minta_pin_cvv", "apk_mencurigakan", "remote_access")

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
     * Fuse rules with an SLM verdict.
     *
     * @param slmLabel a label from a real [SlmClassifier] (e.g. [OllamaSlmClassifier]).
     *   When null, the offline [StubSlmClassifier] is consulted iff [useModelStage].
     *
     * The SLM is only consulted for borderline messages (score >= WARN) and can
     * only ESCALATE — it never lowers a verdict the rules already reached.
     */
    fun evaluate(
        rawText: String,
        useModelStage: Boolean = true,
        slmLabel: SlmLabel? = null,
    ): GuardVerdict {
        val text = rawText.trim()
        val (score, matched) = score(text)

        var verdict = when {
            score >= BLOCK_THRESHOLD -> Verdict.BLOCK
            score >= WARN_THRESHOLD -> Verdict.WARN
            else -> Verdict.ALLOW
        }

        var modelUsed = false
        var appliedLabel: SlmLabel? = null
        if (score >= WARN_THRESHOLD) {
            val label = slmLabel ?: if (useModelStage) StubSlmClassifier().classify(text).label else null
            if (label != null) {
                modelUsed = true
                appliedLabel = label
                when (label) {
                    SlmLabel.PENIPUAN -> verdict = Verdict.BLOCK
                    SlmLabel.MENCURIGAKAN -> if (verdict == Verdict.ALLOW) verdict = Verdict.WARN
                    SlmLabel.AMAN, SlmLabel.UNKNOWN -> Unit // never downgrade
                }
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
            slmLabel = appliedLabel,
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
