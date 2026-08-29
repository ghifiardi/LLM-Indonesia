package ai.sakana.tantularguard

import java.util.Locale

/** Consumer Message Assistant: local, copy-only smart reply drafting. */
object SmartReplyDraft {

    enum class Tone(val label: String) {
        POLITE("Sopan"),
        SHORT("Singkat"),
        FORMAL("Formal"),
        FRIENDLY("Ramah"),
        COMPLAINT("Komplain"),
        CONFIRMATION("Konfirmasi"),
        CANCELLATION("Pembatalan"),
    }

    data class Result(val tone: Tone, val text: String)

    fun draft(
        originalText: String?,
        triage: MessageTriage.Result?,
        verdict: RiskScorer.GuardVerdict?,
        tone: Tone,
    ): Result {
        val raw = originalText.orEmpty().trim()
        val lower = raw.lowercase(Locale.ROOT)
        val category = triage?.category ?: categoryFromText(lower)
        val unsafe = verdict?.verdict == RiskScorer.Verdict.BLOCK ||
            verdict?.accountTakeover == true ||
            category in setOf("keamanan_akun", "penipuan")

        val text = if (unsafe) safeReply(tone) else normalReply(tone, category, triage)
        return Result(tone, text.cleanOneLine())
    }

    private fun safeReply(tone: Tone): String = when (tone) {
        Tone.SHORT -> "Maaf, saya cek dulu lewat kanal resmi."
        Tone.FORMAL -> "Terima kasih. Untuk keamanan, saya akan memeriksa informasi ini melalui kanal resmi terlebih dahulu."
        Tone.FRIENDLY -> "Makasih ya. Aku cek dulu lewat kanal resmi supaya aman."
        Tone.COMPLAINT -> "Mohon maaf, saya belum bisa menindaklanjuti permintaan ini sebelum informasinya terverifikasi melalui kanal resmi."
        Tone.CONFIRMATION -> "Saya terima informasinya, tetapi akan saya verifikasi dulu melalui kanal resmi."
        Tone.CANCELLATION -> "Maaf, saya batalkan/tunda dulu sampai informasinya bisa diverifikasi melalui kanal resmi."
        Tone.POLITE -> "Terima kasih informasinya. Saya cek dulu melalui kanal resmi sebelum melanjutkan."
    }

    private fun normalReply(tone: Tone, category: String, triage: MessageTriage.Result?): String = when (tone) {
        Tone.SHORT -> shortReply(category)
        Tone.FORMAL -> formalReply(category, triage)
        Tone.FRIENDLY -> friendlyReply(category)
        Tone.COMPLAINT -> complaintReply(category)
        Tone.CONFIRMATION -> confirmationReply(category)
        Tone.CANCELLATION -> cancellationReply(category)
        Tone.POLITE -> politeReply(category, triage)
    }

    private fun politeReply(category: String, triage: MessageTriage.Result?): String {
        val date = firstItem(triage, "date")
        return when (category) {
            "jadwal" -> if (date != null) "Terima kasih informasinya. Saya cek jadwal $date dulu ya, nanti saya konfirmasi kembali." else "Terima kasih informasinya. Saya cek jadwal dulu ya, nanti saya konfirmasi kembali."
            "paket" -> "Terima kasih informasinya. Saya cek detail pengiriman terlebih dahulu."
            "tagihan" -> "Terima kasih informasinya. Saya cek detail tagihan terlebih dahulu sebelum melakukan pembayaran."
            "promo" -> "Terima kasih informasinya. Saya cek syarat dan masa berlakunya dulu."
            else -> "Terima kasih informasinya. Saya cek dulu dan akan kabari kembali."
        }
    }

    private fun shortReply(category: String): String = when (category) {
        "jadwal" -> "Siap, saya cek jadwal dulu."
        "paket" -> "Baik, saya cek resinya dulu."
        "tagihan" -> "Baik, saya cek tagihannya dulu."
        "promo" -> "Makasih, saya cek dulu."
        else -> "Baik, saya cek dulu ya."
    }

    private fun formalReply(category: String, triage: MessageTriage.Result?): String {
        val date = firstItem(triage, "date")
        return when (category) {
            "jadwal" -> if (date != null) "Terima kasih atas informasinya. Saya akan meninjau jadwal pada $date dan memberikan konfirmasi kembali." else "Terima kasih atas informasinya. Saya akan meninjau jadwal tersebut dan memberikan konfirmasi kembali."
            "paket" -> "Terima kasih atas informasinya. Saya akan memeriksa detail pengiriman tersebut terlebih dahulu."
            "tagihan" -> "Terima kasih atas informasinya. Saya akan memeriksa detail tagihan melalui kanal resmi terlebih dahulu."
            else -> "Terima kasih atas informasinya. Saya akan meninjau terlebih dahulu dan memberikan konfirmasi kembali."
        }
    }

    private fun friendlyReply(category: String): String = when (category) {
        "jadwal" -> "Siap, makasih ya. Aku cek jadwal dulu 😊"
        "paket" -> "Siap, makasih. Aku cek pengirimannya dulu ya."
        "tagihan" -> "Siap, makasih. Aku cek detailnya dulu ya."
        else -> "Siap, makasih ya. Aku cek dulu 😊"
    }

    private fun complaintReply(category: String): String = when (category) {
        "paket" -> "Mohon bantuannya untuk mengecek pengiriman ini, karena informasinya belum jelas bagi saya."
        "tagihan" -> "Mohon bantuannya untuk mengecek kembali tagihan ini, karena saya perlu memastikan detailnya benar."
        "jadwal" -> "Mohon maaf, jadwal tersebut kurang sesuai bagi saya. Apakah bisa dibantu opsi waktu lain?"
        else -> "Mohon bantuannya untuk mengecek hal ini, karena informasinya belum jelas bagi saya."
    }

    private fun confirmationReply(category: String): String = when (category) {
        "jadwal" -> "Baik, saya konfirmasi hadir sesuai jadwal."
        "paket" -> "Baik, saya konfirmasi sudah menerima informasi pengiriman ini."
        "tagihan" -> "Baik, saya konfirmasi sudah menerima informasi tagihan ini dan akan mengeceknya."
        "promo" -> "Baik, saya konfirmasi sudah menerima informasi promo ini."
        else -> "Baik, saya konfirmasi sudah menerima informasinya."
    }

    private fun cancellationReply(category: String): String = when (category) {
        "jadwal" -> "Mohon maaf, saya belum bisa mengikuti jadwal tersebut. Saya batalkan dulu ya."
        "paket" -> "Mohon maaf, saya belum bisa melanjutkan pengiriman/pesanan ini. Saya tunda dulu."
        "tagihan" -> "Mohon maaf, saya tunda dulu sampai detail tagihannya jelas."
        else -> "Mohon maaf, saya belum bisa melanjutkan. Saya batalkan/tunda dulu ya."
    }

    private fun firstItem(triage: MessageTriage.Result?, kind: String): String? =
        triage?.items?.firstOrNull { it.kind == kind }?.value

    private fun categoryFromText(lower: String): String = when {
        containsAny(lower, "otp", "kode login", "kode verifikasi", "perangkat tertaut") -> "keamanan_akun"
        containsAny(lower, "tagihan", "bayar", "pembayaran", "invoice", "jatuh tempo") -> "tagihan"
        containsAny(lower, "paket", "kurir", "resi", "pengiriman") -> "paket"
        containsAny(lower, "meeting", "rapat", "jadwal", "besok", "lusa") -> "jadwal"
        containsAny(lower, "promo", "diskon", "voucher", "cashback") -> "promo"
        else -> "umum"
    }

    private fun containsAny(blob: String, vararg terms: String): Boolean = terms.any { blob.contains(it) }

    private fun String.cleanOneLine(): String =
        trim().replace(Regex("""\s+"""), " ")
}
