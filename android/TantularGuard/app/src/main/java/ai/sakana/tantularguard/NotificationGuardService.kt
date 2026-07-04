package ai.sakana.tantularguard

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.io.File
import java.util.concurrent.Executors

/**
 * Opt-in Account Takeover / scam guard for messaging + social notifications.
 *
 * Privacy posture:
 *   - Disabled unless the user turns on KEY_NOTIF_GUARD_ON AND grants the system
 *     notification-access permission.
 *   - Reads only the notification preview text of monitored apps (WhatsApp,
 *     WhatsApp Business, and common social apps). It does NOT read full chat
 *     history and cannot access the apps' private databases.
 *   - Classification runs fully locally with deterministic rules (no network,
 *     no dev-server SLM). Borderline notifications additionally run the
 *     on-device Tantular SLM off the callback thread — but only if the user
 *     enabled SLM AND the backend is on-device. Background never calls the
 *     network, keeping the privacy posture intact.
 */
class NotificationGuardService : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return
        val notifGuardOn = guardEnabled()
        val digestOn = digestEnabled()
        if (!notifGuardOn && !digestOn) return

        val pkg = sbn.packageName ?: return
        if (pkg == packageName) return

        val notification = sbn.notification ?: return
        // Skip group summaries and ongoing/transport notifications (e.g. calls).
        if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        val extras = notification.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            ?: ""
        val body = text.trim()
        if (body.isEmpty()) return
        // Ignore common non-message chatter.
        val lowered = body.lowercase()
        if (lowered.contains("new messages") || lowered.contains("pesan baru") ||
            lowered.contains("checking for messages") || lowered.contains("mengecek pesan")
        ) return

        // Personal Notification Digest (Cluster D): organize useful notifications
        // into a daily summary, independent of the scam verdict. Content-first,
        // non-system apps only; nothing leaves the device.
        if (digestOn && !isSystemPackage(pkg)) {
            captureDigest(pkg, title, body)
        }

        // Scam / account-takeover guard: messaging + social apps only.
        if (!notifGuardOn || pkg !in MONITORED_PACKAGES) return

        val verdict = RiskScorer.evaluate(body, useModelStage = false)
        val borderline = RiskScorer.shouldUseModelStage(body)
        val label = appLabel(pkg)
        if (verdict.verdict == RiskScorer.Verdict.ALLOW && !borderline) {
            GuardLog.add(this, label, title, body, verdict, GuardLog.ROUTE_INBOX)
            return
        }

        val key = (pkg + "|" + body).hashCode()
        synchronized(recent) {
            if (recent.contains(key)) return
            recent.add(key)
            if (recent.size > MAX_RECENT) recent.removeAt(0)
        }

        // Borderline + on-device SLM enabled: escalate off the callback thread.
        if (borderline && onDeviceSlmEnabled()) {
            val ctx = applicationContext
            slmExecutor.execute {
                val fused = runOnDeviceSlm(ctx, body) ?: verdict
                GuardLog.add(ctx, label, title, body, fused, if (fused.verdict == RiskScorer.Verdict.ALLOW) GuardLog.ROUTE_INBOX else GuardLog.ROUTE_WARNING)
                if (fused.verdict != RiskScorer.Verdict.ALLOW) {
                    postWarning(ctx, label, body, fused)
                }
            }
            return
        }

        if (verdict.verdict != RiskScorer.Verdict.ALLOW) {
            GuardLog.add(this, label, title, body, verdict, GuardLog.ROUTE_WARNING)
            postWarning(this, label, body, verdict)
        }
    }

    private fun guardEnabled(): Boolean =
        getSharedPreferences("tantular_guard", Context.MODE_PRIVATE)
            .getBoolean(MainActivity.KEY_NOTIF_GUARD_ON, false)

    private fun digestEnabled(): Boolean =
        getSharedPreferences("tantular_guard", Context.MODE_PRIVATE)
            .getBoolean(MainActivity.KEY_DIGEST_ON, false)

    /**
     * Classify + store one notification for the daily digest. Drops generic
     * "umum" chatter from non-messenger apps so only useful notifications (or
     * personal chats from monitored messengers) are kept.
     */
    private fun captureDigest(pkg: String, title: String, body: String) {
        val cat = NotificationClassifier.classify(body, title)
        if (cat.key == "umum" && pkg !in MONITORED_PACKAGES) return
        NotificationDigestStore.add(
            applicationContext, pkg, appDisplayLabel(pkg), cat.key, cat.priority, title, body,
        )
    }

    /** Skip system/launcher/keyboard packages that never carry a useful digest item. */
    private fun isSystemPackage(pkg: String): Boolean =
        pkg == "android" ||
            pkg.startsWith("com.android.") ||
            pkg == "com.google.android.gms" ||
            pkg == "com.google.android.googlequicksearchbox" ||
            pkg.contains("systemui") ||
            pkg.contains("packageinstaller") ||
            pkg.contains("inputmethod") ||
            pkg.contains("launcher")

    /** Real installed-app name via PackageManager, falling back to the known map. */
    private fun appDisplayLabel(pkg: String): String {
        runCatching {
            val pm = packageManager
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        }
        return appLabel(pkg)
    }

    /**
     * Only run the SLM in the background when the user enabled it AND selected
     * the on-device backend. The dev-server (Ollama) backend is never used from
     * background notification handling, so no message leaves the device here.
     */
    private fun onDeviceSlmEnabled(): Boolean {
        val prefs = getSharedPreferences("tantular_guard", Context.MODE_PRIVATE)
        val on = prefs.getBoolean(MainActivity.KEY_SLM_ON, false)
        val backend = prefs.getString(MainActivity.KEY_SLM_BACKEND, MainActivity.SLM_BACKEND_ON_DEVICE)
        return on && backend == MainActivity.SLM_BACKEND_ON_DEVICE && NativeLlama.AVAILABLE
    }

    private fun runOnDeviceSlm(context: Context, body: String): RiskScorer.GuardVerdict? {
        val modelFile = File(context.getExternalFilesDir(null), "models/tantular.gguf")
        if (!(modelFile.exists() && modelFile.length() > 0L)) return null
        val adapterFile = File(context.getExternalFilesDir(null), "models/tantular-lora.gguf")
        val classifier = OnDeviceSlmClassifier(modelFile, adapterFile.takeIf { it.exists() && it.length() > 0L })
        val result = classifier.classify(body)
        if (!result.ok) return null
        // Fuse: SLM can only escalate; deterministic rules stay the floor.
        return RiskScorer.evaluate(body, useModelStage = false, slmLabel = result.label)
    }

    private fun appLabel(pkg: String): String = when (pkg) {
        "com.whatsapp" -> "WhatsApp"
        "com.whatsapp.w4b" -> "WhatsApp Business"
        "com.instagram.android" -> "Instagram"
        "com.facebook.katana" -> "Facebook"
        "com.facebook.orca" -> "Messenger"
        "org.telegram.messenger" -> "Telegram"
        "com.zhiliaoapp.musically" -> "TikTok"
        else -> pkg
    }

    private fun postWarning(
        context: Context,
        source: String,
        message: String,
        verdict: RiskScorer.GuardVerdict,
    ) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannel(context, manager)

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(SmsReceiver.EXTRA_SMS_TEXT, message)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            message.hashCode(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val takeover = verdict.accountTakeover
        val title = when {
            takeover -> context.getString(R.string.notif_guard_title_takeover, source)
            verdict.verdict == RiskScorer.Verdict.BLOCK ->
                context.getString(R.string.notif_guard_title_block, source)
            else -> context.getString(R.string.notif_guard_title_warn, source)
        }
        val big = verdict.takeoverAdvice ?: verdict.userMessage
        val color = when {
            takeover || verdict.verdict == RiskScorer.Verdict.BLOCK -> 0xFFB91C1C.toInt()
            else -> 0xFFB45E00.toInt()
        }

        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }
        val notification = builder
            .setSmallIcon(R.drawable.ic_tantular_guard)
            .setContentTitle(title)
            .setContentText(
                context.getString(
                    R.string.sms_notification_text_format,
                    verdict.verdict.name,
                    verdict.riskScore,
                ),
            )
            .setStyle(Notification.BigTextStyle().bigText(big))
            .setColor(color)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_ALL)
            .setPriority(Notification.PRIORITY_HIGH)
            .setCategory(Notification.CATEGORY_STATUS)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build()

        manager.notify(NOTIFICATION_ID_BASE + kotlin.math.abs(message.hashCode() % 10000), notification)
    }

    private fun ensureChannel(context: Context, manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < 26) return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notif_guard_channel),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Tantular account-takeover warnings for app notifications"
            enableVibration(true)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private val MONITORED_PACKAGES = setOf(
            "com.whatsapp",
            "com.whatsapp.w4b",
            "com.instagram.android",
            "com.facebook.katana",
            "com.facebook.orca",
            "org.telegram.messenger",
            "com.zhiliaoapp.musically",
        )
        private const val CHANNEL_ID = "tantular_notif_guard_v2"
        private const val NOTIFICATION_ID_BASE = 52000
        private const val MAX_RECENT = 50
        private val recent = ArrayList<Int>()
        private val slmExecutor = Executors.newSingleThreadExecutor()
    }
}
