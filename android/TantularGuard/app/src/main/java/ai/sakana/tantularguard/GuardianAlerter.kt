package ai.sakana.tantularguard

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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
        if (!GuardianStore.isEnabled(context)) { Log.i(TAG, "skip: guardian disabled"); return }
        if (verdict.verdict != RiskScorer.Verdict.BLOCK && !verdict.accountTakeover) {
            Log.i(TAG, "skip: verdict=${verdict.verdict} takeover=${verdict.accountTakeover} (needs BLOCK/takeover)"); return
        }
        val numbers = GuardianStore.numbers(context)
        if (numbers.isEmpty()) { Log.i(TAG, "skip: no guardian numbers"); return }
        if (!canSend(context)) { Log.i(TAG, "skip: SEND_SMS not granted"); return }
        val now = System.currentTimeMillis()
        // Per-incident rate limit: the SAME scam via SMS+WhatsApp shares a key
        // (deduped to one alert), but a genuinely different threat has a
        // different key and still alerts within the 5-minute window.
        val level = GuardianAlert.levelText(verdict.verdict.name, verdict.accountTakeover)
        val key = GuardianAlert.incidentKey(level, verdict.matchedSignals)
        val lastForKey = GuardianStore.lastAlertForKey(context, key)
        if (!GuardianAlert.shouldSend(now, lastForKey)) {
            val agoS = (now - lastForKey) / 1000
            Log.i(TAG, "skip: RATE-LIMITED same incident (${agoS}s ago, window=${GuardianAlert.DEFAULT_MIN_INTERVAL_MS / 1000}s) key=$key")
            notifyStatus(
                context,
                context.getString(R.string.family_alert_skipped_title),
                context.getString(R.string.family_alert_skipped_body),
                ID_STATUS,
            )
            return
        }
        Log.i(TAG, "sending alert to ${numbers.size} guardian(s)... key=$key")

        val signals = RiskScorer.humanSignals(verdict.matchedSignals)
        val body = GuardianAlert.buildAlert(GuardianStore.protectedName(context), level, signals)
        val sent = sendToAll(context, numbers, body)
        if (sent) GuardianStore.recordAlert(context, key, now)
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
        // Record under a dedicated key so a manual test never suppresses a real
        // incident alert (and vice versa).
        if (sent) GuardianStore.recordAlert(context, "manual_test", System.currentTimeMillis())
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
        val app = context.applicationContext
        registerResultLogger(app)
        var any = false
        for ((idx, n) in numbers.withIndex()) {
            val ok = runCatching {
                val parts = sms.divideMessage(body)
                val sent = PendingIntent.getBroadcast(
                    app, idx,
                    Intent(ACTION_SENT).setPackage(app.packageName),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val delivered = PendingIntent.getBroadcast(
                    app, 1000 + idx,
                    Intent(ACTION_DELIVERED).setPackage(app.packageName),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                if (parts.size > 1) {
                    val sentIntents = ArrayList<PendingIntent>().apply { repeat(parts.size) { add(sent) } }
                    val delIntents = ArrayList<PendingIntent>().apply { repeat(parts.size) { add(delivered) } }
                    sms.sendMultipartTextMessage(n, null, parts, sentIntents, delIntents)
                } else {
                    sms.sendTextMessage(n, null, body, sent, delivered)
                }
            }.isSuccess
            Log.i(TAG, "send call for guardian #$idx: threw=${!ok}")
            if (ok) any = true else Log.e(TAG, "failed to send guardian alert (threw synchronously)")
        }
        return any
    }

    /** DIAGNOSTIC: log the real radio result of the SMS send (delivered vs failed). */
    @Volatile private var loggerRegistered = false
    private fun registerResultLogger(app: Context) {
        if (loggerRegistered) return
        loggerRegistered = true
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val ctx = c ?: return
                if (i?.action == ACTION_DELIVERED) {
                    if (resultCode == Activity.RESULT_OK) {
                        Log.i(TAG, "SMS delivery REPORT: DELIVERED — carrier confirmed the guardian received it")
                    } else {
                        Log.i(TAG, "SMS delivery REPORT: NOT DELIVERED (code=$resultCode) — pulsa/blocked/filtered")
                        notifyStatus(
                            ctx,
                            ctx.getString(R.string.family_alert_undelivered_title),
                            ctx.getString(R.string.family_alert_undelivered_body),
                            ID_STATUS,
                        )
                    }
                    return
                }
                val meaning = when (resultCode) {
                    Activity.RESULT_OK -> "OK — radio accepted the SMS (handoff to network)"
                    SmsManager.RESULT_ERROR_NO_SERVICE -> "NO_SERVICE — no cellular signal/SIM"
                    SmsManager.RESULT_ERROR_RADIO_OFF -> "RADIO_OFF — airplane mode / radio off"
                    SmsManager.RESULT_ERROR_NULL_PDU -> "NULL_PDU"
                    SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "GENERIC_FAILURE — carrier/SIM rejected"
                    else -> "code=$resultCode"
                }
                Log.i(TAG, "SMS send RESULT: $meaning")
                if (resultCode != Activity.RESULT_OK) {
                    notifyStatus(
                        ctx,
                        ctx.getString(R.string.family_alert_sendfail_title),
                        ctx.getString(R.string.family_alert_sendfail_body),
                        ID_STATUS,
                    )
                }
            }
        }
        val filter = IntentFilter(ACTION_SENT).apply { addAction(ACTION_DELIVERED) }
        if (Build.VERSION.SDK_INT >= 33) {
            app.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            app.registerReceiver(receiver, filter)
        }
    }

    /** Post a local status notification on the protected phone (deduped by id). */
    private fun notifyStatus(context: Context, title: String, body: String, id: Int) {
        runCatching {
            val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26 && mgr.getNotificationChannel(CHANNEL_ID) == null) {
                mgr.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Status Pelindung Keluarga", NotificationManager.IMPORTANCE_HIGH),
                )
            }
            val builder = if (Build.VERSION.SDK_INT >= 26) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION") Notification.Builder(context)
            }
            val n = builder
                .setSmallIcon(R.drawable.ic_tantular_guard)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setColor(0xFFB45E00.toInt())
                .setAutoCancel(true)
                .build()
            mgr.notify(id, n)
        }
    }

    private const val CHANNEL_ID = "tantular_guardian_status"
    private const val ID_STATUS = 53000
    private const val ACTION_SENT = "ai.sakana.tantularguard.GUARDIAN_SMS_SENT"
    private const val ACTION_DELIVERED = "ai.sakana.tantularguard.GUARDIAN_SMS_DELIVERED"
}
