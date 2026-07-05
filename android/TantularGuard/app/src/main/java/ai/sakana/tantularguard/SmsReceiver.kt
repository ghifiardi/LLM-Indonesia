package ai.sakana.tantularguard

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Telephony

/**
 * Stage 2: opt-in incoming SMS guard.
 * Stage 2B: if this app is default SMS app, quarantine BLOCK/WARN instead of
 * writing them to the system SMS inbox.
 *
 * This receiver only does useful work when:
 *   1. the user enabled MainActivity.KEY_SMS_GUARD_ON, and
 *   2. Android granted RECEIVE_SMS, and
 *   3. an incoming SMS is BLOCK/WARN according to RiskScorer.
 *
 * It does not call any remote SLM backend: background SMS handling should remain
 * local, fast, predictable, and battery-friendly. The user can tap the
 * notification to open MainActivity and optionally run the on-device SLM layer
 * manually for borderline messages.
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        // Mode Pelindung: on a guardian's phone, capture Tantular alert SMS
        // directly — regardless of the scam-guard toggle — so they surface in-app
        // even if the Messages app files them into a spam folder. SMS_RECEIVED
        // reaches observer apps before any such foldering.
        if (guardianModeEnabled(context)) {
            val parsed = extractSms(intent)
            if (GuardianAlert.looksLikeGuardianAlert(parsed.body)) {
                val stored = GuardianInbox.add(context, parsed.address, parsed.body, parsed.timestampMs)
                if (stored != null) postGuardianInboxNotification(context, parsed.body)
                // If we are the default SMS app, still persist it so it isn't lost.
                if (Telephony.Sms.getDefaultSmsPackage(context) == context.packageName) {
                    writeToInbox(context, parsed)
                }
                return
            }
        }
        when (intent.action) {
            Telephony.Sms.Intents.SMS_DELIVER_ACTION -> handleDefaultSmsDelivery(context, intent)
            Telephony.Sms.Intents.SMS_RECEIVED_ACTION -> handleObserverWarning(context, intent)
        }
    }

    private fun guardianModeEnabled(context: Context): Boolean =
        context.getSharedPreferences("tantular_guard", Context.MODE_PRIVATE)
            .getBoolean(MainActivity.KEY_GUARDIAN_MODE_ON, false)

    private fun postGuardianInboxNotification(context: Context, body: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(GUARDIAN_CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    GUARDIAN_CHANNEL_ID,
                    context.getString(R.string.guardian_inbox_channel),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply { enableVibration(true) },
            )
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val openIntent = Intent(context, GuardianInboxActivity::class.java)
            .apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP }
        val pending = PendingIntent.getActivity(
            context, body.hashCode(), openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(context, GUARDIAN_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(context)
        }
        val n = builder
            .setSmallIcon(R.drawable.ic_tantular_guard)
            .setContentTitle(context.getString(R.string.guardian_inbox_notif_title))
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setColor(0xFFB91C1C.toInt())
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build()
        manager.notify(GUARDIAN_NOTIFICATION_ID_BASE + kotlin.math.abs(body.hashCode() % 10000), n)
    }

    /**
     * Stage 2B default-SMS path.
     *
     * Safer routing so normal messages never disappear:
     *   - guard off        -> write to inbox
     *   - ALLOW            -> write to inbox (logged)
     *   - WARN             -> write to inbox + warn (logged) — NOT quarantined
     *   - BLOCK            -> quarantine only + warn (logged)
     */
    private fun handleDefaultSmsDelivery(context: Context, intent: Intent) {
        val parsed = extractSms(intent)

        // As the default SMS app, SMS_DELIVER is the ONLY path that persists an
        // incoming message. Never drop one: a blank body still goes to the inbox
        // (there is simply nothing to risk-score, so skip scoring — not delivery).
        if (parsed.body.isBlank()) {
            writeToInbox(context, parsed)
            return
        }

        if (!smsGuardEnabled(context)) {
            writeToInbox(context, parsed)
            return
        }

        val verdict = RiskScorer.evaluate(parsed.body, useModelStage = false)
        when (verdict.verdict) {
            RiskScorer.Verdict.ALLOW -> {
                writeToInbox(context, parsed)
                GuardLog.add(context, "SMS", parsed.address, parsed.body, verdict, GuardLog.ROUTE_INBOX)
            }
            RiskScorer.Verdict.WARN -> {
                // Keep the message in the inbox; only warn. Do not quarantine.
                writeToInbox(context, parsed)
                GuardLog.add(context, "SMS", parsed.address, parsed.body, verdict, GuardLog.ROUTE_INBOX_WARN)
                postWarningNotification(context, parsed.body, verdict, quarantineId = null)
                GuardianAlerter.maybeAlert(context, verdict)
            }
            RiskScorer.Verdict.BLOCK -> {
                val item = SmsQuarantine.add(context, parsed.address, parsed.body, verdict)
                GuardLog.add(context, "SMS", parsed.address, parsed.body, verdict, GuardLog.ROUTE_QUARANTINE)
                postWarningNotification(context, parsed.body, verdict, quarantineId = item.id)
                GuardianAlerter.maybeAlert(context, verdict)
            }
        }
    }

    /** Stage 2 observer path: warning only; SMS still lands in default inbox. */
    private fun handleObserverWarning(context: Context, intent: Intent) {
        if (!smsGuardEnabled(context)) return
        if (Telephony.Sms.getDefaultSmsPackage(context) == context.packageName) return

        val text = extractSms(intent).body.trim()
        if (text.isEmpty()) return
        val address = extractSms(intent).address

        val verdict = RiskScorer.evaluate(text, useModelStage = false)
        if (verdict.verdict == RiskScorer.Verdict.ALLOW) {
            // System already delivered it to the default inbox; just log for visibility.
            GuardLog.add(context, "SMS", address, text, verdict, GuardLog.ROUTE_INBOX)
            return
        }
        GuardLog.add(context, "SMS", address, text, verdict, GuardLog.ROUTE_WARNING)
        postWarningNotification(context, text, verdict, quarantineId = null)
        GuardianAlerter.maybeAlert(context, verdict)
    }

    private fun smsGuardEnabled(context: Context): Boolean =
        context.getSharedPreferences("tantular_guard", Context.MODE_PRIVATE)
            .getBoolean(MainActivity.KEY_SMS_GUARD_ON, false)

    private fun extractSms(intent: Intent): ParsedSms {
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        val body = messages.joinToString(separator = "\n") { it.messageBody.orEmpty() }
        val address = messages.firstOrNull()?.displayOriginatingAddress
            ?: messages.firstOrNull()?.originatingAddress
            ?: ""
        val timestamp = messages.firstOrNull()?.timestampMillis ?: System.currentTimeMillis()
        return ParsedSms(address = address, body = body, timestampMs = timestamp)
    }

    private fun writeToInbox(context: Context, sms: ParsedSms) {
        val values = ContentValues().apply {
            put(Telephony.Sms.ADDRESS, sms.address)
            put(Telephony.Sms.BODY, sms.body)
            put(Telephony.Sms.DATE, sms.timestampMs)
            put(Telephony.Sms.READ, 0)
            put(Telephony.Sms.SEEN, 0)
            put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX)
        }
        runCatching {
            context.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI, values)
        }
    }

    private fun postWarningNotification(
        context: Context,
        smsText: String,
        verdict: RiskScorer.GuardVerdict,
        quarantineId: String?,
    ) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannel(context, manager)

        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (quarantineId != null) {
                putExtra(SmsQuarantine.EXTRA_QUARANTINE_ID, quarantineId)
            } else {
                putExtra(EXTRA_SMS_TEXT, smsText)
            }
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            smsText.hashCode(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val title = when (verdict.verdict) {
            RiskScorer.Verdict.BLOCK -> context.getString(R.string.sms_notification_title_block)
            RiskScorer.Verdict.WARN -> context.getString(R.string.sms_notification_title_warn)
            RiskScorer.Verdict.ALLOW -> return
        }
        val text = context.getString(
            R.string.sms_notification_text_format,
            verdict.verdict.name,
            verdict.riskScore,
        )
        val color = when (verdict.verdict) {
            RiskScorer.Verdict.BLOCK -> 0xFFB91C1C.toInt()
            RiskScorer.Verdict.WARN -> 0xFFB45E00.toInt()
            RiskScorer.Verdict.ALLOW -> 0xFF15803D.toInt()
        }

        val notification = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }
            .setSmallIcon(R.drawable.ic_tantular_guard)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(verdict.userMessage))
            .setColor(color)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_ALL)
            .setPriority(Notification.PRIORITY_HIGH)
            .setCategory(Notification.CATEGORY_STATUS)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build()

        manager.notify(NOTIFICATION_ID_BASE + kotlin.math.abs(smsText.hashCode() % 10000), notification)
    }

    private fun ensureChannel(context: Context, manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < 26) return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.sms_notification_channel),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Tantular Guard warnings for suspicious incoming SMS"
            enableVibration(true)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        const val EXTRA_SMS_TEXT = "ai.sakana.tantularguard.extra.SMS_TEXT"
        private const val CHANNEL_ID = "tantular_sms_guard_v2"
        private const val NOTIFICATION_ID_BASE = 42000
        private const val GUARDIAN_CHANNEL_ID = "tantular_guardian_inbox_v1"
        private const val GUARDIAN_NOTIFICATION_ID_BASE = 54000
    }

    private data class ParsedSms(
        val address: String,
        val body: String,
        val timestampMs: Long,
    )
}
