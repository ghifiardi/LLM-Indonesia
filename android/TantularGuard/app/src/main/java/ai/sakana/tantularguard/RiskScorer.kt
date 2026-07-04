package ai.sakana.tantularguard

import kotlin.math.round

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
        val accountTakeover: Boolean = false,
        val takeoverAdvice: String? = null,
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

    /**
     * Account-takeover (ATO) signals. These target attempts to hijack WhatsApp,
     * WhatsApp Business, social media, email, or banking accounts. They add to
     * the same risk score and also drive the [GuardVerdict.accountTakeover] flag
     * plus tailored recovery advice.
     */
    private val takeoverSignals: Map<String, Pair<Double, List<String>>> = mapOf(
        "kode_verifikasi_akun" to (0.45 to listOf(
            "kode verifikasi", "kode login", "kode 6 digit", "6 digit", "verification code",
            "kode masuk", "kode aktivasi", "kode wa", "kode whatsapp",
        )),
        "minta_bagikan_kode" to (0.45 to listOf(
            "bagikan kode", "kirim kode", "sebutkan kode", "berikan kode", "share kode",
            "salah kirim kode", "kode nyasar", "tolong kodenya",
        )),
        "dukungan_palsu" to (0.30 to listOf(
            "admin whatsapp", "admin meta", "pusat bantuan", "support whatsapp", "meta support",
            "tim keamanan", "instagram support", "facebook security", "verifikasi akun",
            "centang biru", "verified badge",
        )),
        "ancaman_blokir_akun" to (0.30 to listOf(
            "akun akan diblokir", "akun diblokir", "akun dinonaktifkan", "akun ditangguhkan",
            "account suspended", "akun dihapus", "pelanggaran kebijakan",
        )),
        "link_login_palsu" to (0.30 to listOf(
            "login ulang", "verifikasi login", "reset password", "atur ulang kata sandi",
            "tautan pemulihan", "recovery link", "confirm your account", "amankan akun",
        )),
        "perangkat_tertaut" to (0.35 to listOf(
            "perangkat tertaut", "linked device", "tautkan perangkat", "scan qr", "pindai qr",
            "whatsapp web", "login perangkat baru", "device baru",
        )),
        "nonaktifkan_2fa" to (0.35 to listOf(
            "nonaktifkan 2fa", "matikan verifikasi dua langkah", "matikan two-step",
            "disable 2fa", "hapus pin verifikasi",
        )),
        "sim_swap" to (0.30 to listOf(
            "ganti kartu sim", "sim swap", "upgrade sim", "registrasi ulang sim",
            "tukar sim", "sim baru",
        )),
        "bagikan_layar" to (0.35 to listOf(
            "bagikan layar", "share screen", "screen sharing", "pantau layar",
        )),
    )

    private const val BLOCK_THRESHOLD = 0.75
    private const val WARN_THRESHOLD = 0.35

    internal val HIGH_RISK = setOf("minta_otp", "minta_pin_cvv", "apk_mencurigakan", "remote_access")

    /**
     * ATO signals that are dangerous enough to force a BLOCK-level hard gate on
     * their own (they map directly to account hijack).
     */
    internal val TAKEOVER_HARD = setOf(
        "minta_bagikan_kode", "nonaktifkan_2fa", "perangkat_tertaut", "bagikan_layar",
    )

    /**
     * Plain-Indonesian labels for signal codes, shown to non-technical users.
     * Unknown codes fall back to the raw code so nothing ever renders blank.
     */
    private val signalLabels: Map<String, String> = mapOf(
        "minta_otp" to "Meminta kode OTP",
        "minta_pin_cvv" to "Meminta PIN/CVV kartu",
        "minta_password" to "Meminta password",
        "link_mencurigakan" to "Ada tautan mencurigakan",
        "apk_mencurigakan" to "Minta pasang aplikasi/APK",
        "remote_access" to "Minta akses jarak jauh",
        "iming_hadiah" to "Iming-iming hadiah/undian",
        "refund_palsu" to "Modus refund dana",
        "urgensi" to "Nada mendesak/menakut-nakuti",
        "mengaku_petugas" to "Mengaku petugas/CS bank",
        "kode_verifikasi_akun" to "Menyebut kode verifikasi akun",
        "minta_bagikan_kode" to "Minta membagikan kode",
        "dukungan_palsu" to "Berpura-pura layanan resmi",
        "ancaman_blokir_akun" to "Mengancam akun diblokir",
        "link_login_palsu" to "Tautan login/reset palsu",
        "perangkat_tertaut" to "Ajakan tautkan perangkat/QR",
        "nonaktifkan_2fa" to "Minta matikan verifikasi 2 langkah",
        "sim_swap" to "Indikasi pembajakan nomor SIM",
        "bagikan_layar" to "Minta berbagi layar",
    )

    /** Human label for one signal code (falls back to the raw code). */
    fun humanSignal(code: String): String = signalLabels[code] ?: code

    /** Human labels for a list of signal codes, ready for display. */
    fun humanSignals(codes: List<String>): List<String> = codes.map { humanSignal(it) }

    /** Non-technical risk wording derived from the verdict. */
    fun riskLevelLabel(verdict: Verdict): String = when (verdict) {
        Verdict.BLOCK -> "Tinggi"
        Verdict.WARN -> "Sedang"
        Verdict.ALLOW -> "Rendah"
    }

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
        for ((name, pair) in takeoverSignals) {
            val (weight, terms) = pair
            if (terms.any { lowered.contains(it) }) {
                score += weight
                matched.add(name)
            }
        }
        return minOf(score, 1.0) to matched
    }

    /** Deterministic hard-safety floor that does not depend on an SLM. */
    private fun hasHardFraudGate(text: String, matched: List<String>): Boolean {
        val lowered = text.lowercase()
        return matched.contains("minta_otp") ||
            (matched.contains("minta_pin_cvv") && (lowered.contains("pin") || lowered.contains("cvv"))) ||
            matched.contains("minta_password") ||
            matched.contains("apk_mencurigakan") ||
            matched.contains("remote_access") ||
            matched.any { it in TAKEOVER_HARD }
    }

    /** True when a message looks related to account takeover or recovery. */
    fun isAccountTakeoverRisk(matchedSignals: List<String>): Boolean =
        matchedSignals.any { it in takeoverSignals.keys || it in setOf("minta_otp", "minta_password", "apk_mencurigakan", "remote_access") }

    fun recoveryChecklist(platformHint: String? = null): String {
        val platform = platformHint?.takeIf { it.isNotBlank() } ?: "WhatsApp / media sosial"
        return (
            "Panduan pemulihan $platform:\n" +
                "1. Jangan bagikan OTP, PIN, password, atau kode 6 digit kepada siapa pun.\n" +
                "2. Buka aplikasi resmi, bukan link dari chat/SMS.\n" +
                "3. Ganti password dan aktifkan 2FA/passkey/verifikasi dua langkah.\n" +
                "4. Cek perangkat tertaut / sesi login, lalu keluarkan perangkat yang tidak dikenal.\n" +
                "5. Amankan email pemulihan dan nomor HP; hubungi operator bila curiga SIM swap.\n" +
                "6. Hapus aplikasi/APK mencurigakan dan cabut izin aksesibilitas/notifikasi yang tidak dikenal.\n" +
                "7. Beri tahu kontak jika akun sempat mengirim pesan mencurigakan."
            )
    }

    private fun takeoverAdvice(matched: List<String>): String? {
        if (!isAccountTakeoverRisk(matched)) return null
        val priority = when {
            "minta_bagikan_kode" in matched || "kode_verifikasi_akun" in matched ->
                "Risiko pengambilalihan akun: jangan kirim kode verifikasi/OTP. Kode itu bisa dipakai untuk masuk ke akun Anda."
            "perangkat_tertaut" in matched ->
                "Risiko linked-device: jangan scan QR atau tautkan perangkat jika bukan dari aplikasi resmi yang Anda buka sendiri."
            "nonaktifkan_2fa" in matched ->
                "Risiko takeover: jangan matikan 2FA/verifikasi dua langkah atas instruksi orang lain."
            "apk_mencurigakan" in matched ->
                "Risiko malware: jangan install APK dari chat. APK dapat mencuri OTP dan mengambil alih akun."
            "remote_access" in matched || "bagikan_layar" in matched ->
                "Risiko remote access: jangan beri akses layar/perangkat. Pelaku bisa membaca kode dan mengambil alih akun."
            "dukungan_palsu" in matched || "ancaman_blokir_akun" in matched ->
                "Risiko dukungan palsu: jangan percaya ancaman blokir dari chat. Cek langsung lewat aplikasi resmi."
            else ->
                "Ada sinyal risiko pengambilalihan akun. Verifikasi lewat aplikasi/kanal resmi sebelum bertindak."
        }
        return priority + "\n\n" + recoveryChecklist()
    }


    /**
     * SLM budget/privacy gate. The model layer is only useful for borderline
     * cases: high enough to deserve context, but not already a deterministic
     * BLOCK. Hard safety-floor cases do not need model inference.
     */
    fun shouldUseModelStage(rawText: String): Boolean {
        val text = rawText.trim()
        val (score, matched) = score(text)
        return score >= WARN_THRESHOLD && score < BLOCK_THRESHOLD && !hasHardFraudGate(text, matched)
    }

    /**
     * Fuse rules with an SLM verdict.
     *
     * @param slmLabel a label from a real [SlmClassifier] (e.g. [OllamaSlmClassifier]).
     *   When null, the offline [StubSlmClassifier] is consulted iff [useModelStage].
     *
     * The SLM is only consulted for borderline messages (WARN <= score < BLOCK)
     * and can only ESCALATE — it never lowers a verdict the rules already reached.
     */
    fun evaluate(
        rawText: String,
        useModelStage: Boolean = true,
        slmLabel: SlmLabel? = null,
    ): GuardVerdict {
        val text = rawText.trim()
        val (score, matched) = score(text)

        var verdict = when {
            hasHardFraudGate(text, matched) -> Verdict.BLOCK
            score >= BLOCK_THRESHOLD -> Verdict.BLOCK
            score >= WARN_THRESHOLD -> Verdict.WARN
            else -> Verdict.ALLOW
        }

        var modelUsed = false
        var appliedLabel: SlmLabel? = null
        if (shouldUseModelStage(text)) {
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

        val accountTakeover = isAccountTakeoverRisk(matched)
        val (title, message) = userFacing(verdict, accountTakeover)
        val advice = takeoverAdvice(matched)
        return GuardVerdict(
            verdict = verdict,
            // Avoid String.format(...).toDouble(): some Android locales format
            // decimals with a comma, which would crash parsing back to Double.
            riskScore = round(score * 1000.0) / 1000.0,
            matchedSignals = matched,
            bannerTitle = title,
            userMessage = message,
            modelStageUsed = modelUsed,
            slmLabel = appliedLabel,
            accountTakeover = accountTakeover,
            takeoverAdvice = advice,
        )
    }

    private fun userFacing(verdict: Verdict, accountTakeover: Boolean): Pair<String, String> = when (verdict) {
        Verdict.BLOCK -> if (accountTakeover) {
            "\u26A0\uFE0F Risiko Pengambilalihan Akun" to (
                "Pesan ini dapat mengarah ke pengambilalihan WhatsApp, media sosial, email, atau akun penting. " +
                    "JANGAN bagikan OTP/kode login, jangan klik link login, jangan install APK, jangan scan QR, " +
                    "dan jangan beri remote access. Buka aplikasi resmi untuk mengecek status akun."
                )
        } else {
            "\u26A0\uFE0F Peringatan: Indikasi Penipuan" to (
                "Pesan ini kemungkinan besar penipuan. JANGAN bagikan OTP, PIN, CVV, " +
                    "atau password; jangan klik link; jangan install APK; jangan beri " +
                    "remote access. Hubungi kanal resmi bank/instansi untuk memastikan."
                )
        }
        Verdict.WARN -> if (accountTakeover) {
            "Hati-hati: Risiko Akun" to (
                "Ada tanda-tanda yang bisa dipakai untuk mengambil alih akun. Jangan buru-buru " +
                    "mengikuti instruksi, dan verifikasi lewat aplikasi resmi sebelum bertindak."
                )
        } else {
            "Hati-hati: Pesan Mencurigakan" to (
                "Ada tanda-tanda mencurigakan pada pesan ini. Jangan buru-buru " +
                    "mengikuti instruksi, jangan bagikan data pribadi, dan verifikasi " +
                    "lewat kanal resmi sebelum bertindak."
                )
        }
        Verdict.ALLOW -> "Tidak ada indikasi bahaya jelas" to (
            "Belum terdeteksi indikator penipuan, tetapi tetap berhati-hati dengan data pribadi."
        )
    }
}
