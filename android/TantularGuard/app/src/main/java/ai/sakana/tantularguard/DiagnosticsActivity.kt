package ai.sakana.tantularguard

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.provider.Telephony
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File

/**
 * Diagnostics / self-test panel. Shows guard readiness (permissions, default
 * SMS, notification access, on-device model + runtime, SLM settings) and lets
 * the user run built-in test messages through the deterministic layer to verify
 * verdicts on-device.
 */
class DiagnosticsActivity : Activity() {

    private lateinit var statusContainer: LinearLayout
    private lateinit var testContainer: LinearLayout

    private val testMessages = listOf(
        "Aman" to "Halo, meeting besok jam 10 di kantor ya",
        "Hati-hati (meragukan)" to "Klik link ini untuk cek hadiah undian Anda ya kak",
        "Bahaya (OTP)" to "CS bank: sebutkan kode OTP Anda sekarang untuk verifikasi",
        "Bahaya (APK)" to "Silakan install APK ini untuk klaim refund Anda",
        "Akun berisiko (kode)" to "Halo, saya admin WhatsApp. Kirim kode 6 digit yang masuk ke HP Anda",
        "Akun berisiko (tautan perangkat)" to "Scan QR ini untuk menautkan perangkat baru ke akun Anda",
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#F1F5F9"))
            isFillViewport = true
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        root.addView(column)

        column.addView(header(getString(R.string.diag_title), 24f))
        column.addView(muted(getString(R.string.diag_subtitle)))

        column.addView(sectionLabel(getString(R.string.diag_status_section)))
        statusContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(statusContainer)

        column.addView(sectionLabel(getString(R.string.diag_test_section)))
        testContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(testContainer)

        setContentView(root)
        buildTests()
    }

    override fun onResume() {
        super.onResume()
        buildStatus()
    }

    private fun buildStatus() {
        statusContainer.removeAllViews()

        val smsGranted = Build.VERSION.SDK_INT < 23 ||
            checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        val notifPerm = Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val defaultSms = Telephony.Sms.getDefaultSmsPackage(this) == packageName
        val notifAccess = notificationAccessEnabled()
        val modelFile = File(getExternalFilesDir(null), "models/tantular.gguf")
        val adapterFile = File(getExternalFilesDir(null), "models/tantular-lora.gguf")
        val modelPresent = modelFile.exists() && modelFile.length() > 0L
        val prefs = getSharedPreferences("tantular_guard", Context.MODE_PRIVATE)

        statusContainer.addView(statusRow(getString(R.string.diag_sms_perm), smsGranted))
        statusContainer.addView(statusRow(getString(R.string.diag_notif_perm), notifPerm))
        statusContainer.addView(statusRow(getString(R.string.diag_notif_access), notifAccess))
        statusContainer.addView(statusRow(getString(R.string.diag_default_sms), defaultSms, warnIfFalse = false))
        statusContainer.addView(statusRow(getString(R.string.diag_model_present), modelPresent))
        statusContainer.addView(statusRow(getString(R.string.diag_adapter_present), adapterFile.exists() && adapterFile.length() > 0L, warnIfFalse = false))
        statusContainer.addView(statusRow(getString(R.string.diag_native_runtime), NativeLlama.AVAILABLE))
        statusContainer.addView(statusRow(getString(R.string.diag_sms_guard_on), prefs.getBoolean(MainActivity.KEY_SMS_GUARD_ON, false), warnIfFalse = false))
        statusContainer.addView(statusRow(getString(R.string.diag_notif_guard_on), prefs.getBoolean(MainActivity.KEY_NOTIF_GUARD_ON, false), warnIfFalse = false))
        statusContainer.addView(statusRow(getString(R.string.diag_slm_on), prefs.getBoolean(MainActivity.KEY_SLM_ON, false), warnIfFalse = false))

        val backend = prefs.getString(MainActivity.KEY_SLM_BACKEND, MainActivity.SLM_BACKEND_ON_DEVICE)
        statusContainer.addView(infoRow(getString(R.string.diag_slm_backend), backend ?: "-"))
        statusContainer.addView(infoRow(getString(R.string.diag_build_type), if (BuildConfig.ALLOW_DEV_SERVER) "debug/dev" else "release/prod"))
    }

    private fun buildTests() {
        testContainer.removeAllViews()
        for ((label, text) in testMessages) {
            val card = card()
            card.addView(TextView(this).apply {
                this.text = label
                setTextColor(Color.parseColor("#0B2545"))
                setTypeface(typeface, Typeface.BOLD)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            })
            card.addView(muted(text).apply { setPadding(0, dp(4), 0, 0) })
            val result = TextView(this).apply {
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                setPadding(0, dp(8), 0, 0)
                visibility = View.GONE
            }
            card.addView(result)
            card.isClickable = true
            card.setOnClickListener {
                val v = RiskScorer.evaluate(text, useModelStage = true)
                val (bg, ink) = verdictColors(v.verdict)
                card.background = (card.background as GradientDrawable).apply { setStroke(dp(2), ink) }
                val sig = if (v.matchedSignals.isEmpty()) "-" else v.matchedSignals.joinToString(", ")
                val ato = if (v.accountTakeover) "\n" + getString(R.string.diag_takeover_flag) else ""
                result.text = "${verdictLabel(v.verdict)} · risiko ${v.riskScore}\nTanda bahaya: $sig$ato"
                result.setTextColor(ink)
                result.visibility = View.VISIBLE
            }
            testContainer.addView(card)
        }
    }

    private fun notificationAccessEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        return enabled.split(':').any { it.contains(packageName, ignoreCase = true) }
    }

    // --- tiny view helpers ---
    private fun header(text: String, sizeSp: Float) = TextView(this).apply {
        this.text = text
        setTextColor(Color.parseColor("#0B2545"))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTypeface(typeface, Typeface.BOLD)
    }

    private fun muted(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(Color.parseColor("#475569"))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    }

    private fun sectionLabel(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(Color.parseColor("#2E74B5"))
        setTypeface(typeface, Typeface.BOLD)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        setPadding(0, dp(16), 0, dp(8))
    }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(14).toFloat()
            setColor(Color.WHITE)
            setStroke(dp(1), Color.parseColor("#E2E8F0"))
        }
        setPadding(dp(14), dp(12), dp(14), dp(12))
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(10) }
    }

    private fun statusRow(label: String, ok: Boolean, warnIfFalse: Boolean = true): View {
        val row = card().apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(TextView(this).apply {
            text = label
            setTextColor(Color.parseColor("#0F172A"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        })
        val badgeInk = when {
            ok -> Color.parseColor("#15803D")
            warnIfFalse -> Color.parseColor("#B91C1C")
            else -> Color.parseColor("#B45309")
        }
        val badgeBg = when {
            ok -> Color.parseColor("#DCFCE7")
            warnIfFalse -> Color.parseColor("#FEE2E2")
            else -> Color.parseColor("#FEF3C7")
        }
        row.addView(TextView(this).apply {
            text = if (ok) getString(R.string.diag_ok) else getString(R.string.diag_off)
            setTextColor(badgeInk)
            setTypeface(typeface, Typeface.BOLD)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(dp(10), dp(3), dp(10), dp(3))
            background = GradientDrawable().apply {
                cornerRadius = dp(20).toFloat()
                setColor(badgeBg)
            }
        })
        return row
    }

    private fun infoRow(label: String, value: String): View {
        val row = card().apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(TextView(this).apply {
            text = label
            setTextColor(Color.parseColor("#0F172A"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        })
        row.addView(TextView(this).apply {
            text = value
            setTextColor(Color.parseColor("#334155"))
            setTypeface(typeface, Typeface.BOLD)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        })
        return row
    }

    private fun verdictColors(verdict: RiskScorer.Verdict): Pair<Int, Int> = when (verdict) {
        RiskScorer.Verdict.BLOCK -> Color.parseColor("#FEE2E2") to Color.parseColor("#B91C1C")
        RiskScorer.Verdict.WARN -> Color.parseColor("#FEF3C7") to Color.parseColor("#B45309")
        RiskScorer.Verdict.ALLOW -> Color.parseColor("#DCFCE7") to Color.parseColor("#15803D")
    }

    private fun verdictLabel(verdict: RiskScorer.Verdict): String = when (verdict) {
        RiskScorer.Verdict.BLOCK -> getString(R.string.verdict_block)
        RiskScorer.Verdict.WARN -> getString(R.string.verdict_warn)
        RiskScorer.Verdict.ALLOW -> getString(R.string.verdict_allow)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
