package ai.sakana.tantularguard

/**
 * Family Guardian pure logic (no Android deps) — unit-testable.
 *
 * Builds privacy-safe alert text and decides normalization / validation /
 * rate-limiting. The alert NEVER contains the original message, sender, or PII.
 */
object GuardianAlert {

    // Same-incident dedup window. Long enough to collapse the burst of duplicate
    // detections for ONE message (SMS + notification double-fire, multipart
    // re-reports, WhatsApp reposts — all within seconds), short enough that a
    // genuine re-occurrence (or a retest) alerts again promptly.
    const val DEFAULT_MIN_INTERVAL_MS = 90 * 1000L // 90 seconds

    /** Trim and normalize an Indonesian phone number to +62 form when possible. */
    fun normalizeNumber(raw: String): String {
        var s = raw.trim().filter { it.isDigit() || it == '+' }
        if (s.startsWith("+")) {
            s = "+" + s.drop(1).filter { it.isDigit() }
            return s
        }
        val digits = s.filter { it.isDigit() }
        return when {
            digits.startsWith("62") -> "+$digits"
            digits.startsWith("0") -> "+62" + digits.drop(1)
            digits.isEmpty() -> ""
            else -> "+$digits"
        }
    }

    fun isValidNumber(raw: String): Boolean {
        val digits = normalizeNumber(raw).filter { it.isDigit() }
        return digits.length in 9..15
    }

    /**
     * Build the guardian SMS body. Privacy-safe: only name + risk level + a short
     * signal summary. Never includes the raw message.
     *
     * Written to read like a personal P2P text, NOT bulk/A2P: no "[Brand]"
     * bracket prefix and no keyword pileup (OTP/PIN/tautan/install) — those trip
     * carrier + on-device spam filters, which would quarantine the very alert
     * meant to warn about a scam. The guardian is expected to phone the person.
     */
    fun buildAlert(protectedName: String?, level: String, signalsHuman: List<String>): String {
        val who = protectedName?.trim().takeUnless { it.isNullOrBlank() } ?: "orang yang Anda jaga"
        // Deliberately keyword-FREE: no "penipuan"/"OTP"/"PIN"/"tautan"/"hadiah".
        // Indonesian carriers (Telkomsel) drop P2P SMS containing those anti-fraud
        // trigger words, so a scam-worded alert gets a false DELIVERED but never
        // reaches the handset. The guardian phones to learn the details.
        //
        // Kept strictly ASCII (GSM-7): a single non-ASCII char like an em-dash
        // forces UCS-2 encoding, which cuts the per-segment limit 160->67 and
        // splits the alert into multiple parts. Multipart UCS-2 alerts are the
        // ones that get partially rejected (GENERIC_FAILURE on a segment) and
        // mis-reassembled by Huawei/iOS spam filters. One ASCII segment = most
        // reliable delivery.
        return "Halo, tolong segera telepon $who dan tanyakan keadaannya sebentar - " +
            "ada pesan di HP-nya yang sebaiknya diperiksa bersama. $ALERT_SIGNATURE"
    }

    /**
     * Stable sign-off that also serves as a machine-detectable signature so a
     * guardian's phone (Mode Pelindung) can recognize an incoming Tantular alert
     * SMS even if the Messages app files it into a spam folder. Human-readable
     * and not spam-triggering, unlike a "[Brand]" prefix.
     */
    const val ALERT_SIGNATURE = "dari aplikasi Tantular"

    fun looksLikeGuardianAlert(body: String?): Boolean =
        body != null && body.contains(ALERT_SIGNATURE, ignoreCase = true)

    fun levelText(verdictName: String, accountTakeover: Boolean): String = when {
        accountTakeover -> "berisiko pengambilalihan akun"
        verdictName == "BLOCK" -> "berisiko tinggi penipuan"
        else -> "mencurigakan"
    }

    fun shouldSend(nowMs: Long, lastMs: Long, minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS): Boolean =
        nowMs - lastMs >= minIntervalMs

    /**
     * Stable key identifying a distinct scam incident, from its risk level +
     * signals. The SAME scam arriving via SMS and WhatsApp yields the same key
     * (so it's deduped to one alert), while a genuinely different threat yields
     * a different key (so it still alerts within the window). Order-independent.
     */
    fun incidentKey(level: String, signals: List<String>): String {
        val sig = signals.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct().sorted()
        return level.trim().lowercase() + "|" + sig.joinToString(",")
    }
}
