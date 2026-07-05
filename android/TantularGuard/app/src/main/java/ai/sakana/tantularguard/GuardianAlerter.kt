package ai.sakana.tantularguard

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import android.util.Log

/**
 * Sends privacy-safe Family Guardian alerts over the phone's own SMS.
 * No server, no cloud. Alerts contain no message content or PII.
 */
object GuardianAlerter {

    private const val TAG = "GuardianAlerter"

    fun canSend(context: Context): Boolean =
        Build.VERSION.SDK_INT < 23 ||
            context.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED

    /** Fire an alert for a real detection, honoring enable + rate limit + verdict. */
    fun maybeAlert(context: Context, verdict: RiskScorer.GuardVerdict) {
        if (!GuardianStore.isEnabled(context)) return
        if (verdict.verdict != RiskScorer.Verdict.BLOCK && !verdict.accountTakeover) return
        val numbers = GuardianStore.numbers(context)
        if (numbers.isEmpty() || !canSend(context)) return
        val now = System.currentTimeMillis()
        if (!GuardianAlert.shouldSend(now, GuardianStore.lastAlertMs(context))) return

        val level = GuardianAlert.levelText(verdict.verdict.name, verdict.accountTakeover)
        val signals = RiskScorer.humanSignals(verdict.matchedSignals)
        val body = GuardianAlert.buildAlert(GuardianStore.protectedName(context), level, signals)
        val sent = sendToAll(context, numbers, body)
        if (sent) GuardianStore.setLastAlertMs(context, now)
    }

    /** Manual test: sends a sample alert now, ignoring verdict + rate limit. */
    fun sendTest(context: Context): Boolean {
        val numbers = GuardianStore.numbers(context)
        if (numbers.isEmpty() || !canSend(context)) return false
        val body = GuardianAlert.buildAlert(
            GuardianStore.protectedName(context),
            "berisiko tinggi penipuan (CONTOH TES)",
            listOf("diminta OTP"),
        )
        val sent = sendToAll(context, numbers, body)
        if (sent) GuardianStore.setLastAlertMs(context, System.currentTimeMillis())
        return sent
    }

    fun previewText(context: Context): String = GuardianAlert.buildAlert(
        GuardianStore.protectedName(context),
        "berisiko tinggi penipuan",
        listOf("diminta OTP"),
    )

    private fun smsManager(context: Context): SmsManager =
        if (Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }

    private fun sendToAll(context: Context, numbers: List<String>, body: String): Boolean {
        val sms = smsManager(context)
        var any = false
        for (n in numbers) {
            val ok = runCatching {
                val parts = sms.divideMessage(body)
                if (parts.size > 1) {
                    sms.sendMultipartTextMessage(n, null, parts, null, null)
                } else {
                    sms.sendTextMessage(n, null, body, null, null)
                }
            }.isSuccess
            if (ok) any = true else Log.e(TAG, "failed to send guardian alert")
        }
        return any
    }
}
