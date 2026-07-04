package ai.sakana.tantularguard

import android.app.Activity
import android.app.AlertDialog
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.app.role.RoleManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.provider.Telephony
import android.text.method.LinkMovementMethod
import android.view.View
import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.TextView
import android.widget.Toast
import java.io.File

/**
 * Tantular Guard.
 *
 * Two ways to check a message:
 *   1. paste text into the box and tap "Periksa Pesan"
 *   2. share a message from SMS/WhatsApp/etc. into this app (ACTION_SEND)
 *   3. Stage 2: opt in to incoming-SMS checks (RECEIVE_SMS runtime permission)
 *
 * Verdict flow:
 *   text -> [RiskScorer] deterministic rules (offline, instant)
 *        -> if borderline AND the Tantular SLM toggle is on, use the selected
 *           SLM backend. Production default is on-device; remote Ollama is an
 *           explicit dev-only escape hatch. The SLM can only escalate; the
 *           rules stay the hard safety floor.
 */
class MainActivity : Activity() {

    private lateinit var input: EditText
    private lateinit var verdictBanner: TextView
    private lateinit var verdictMessage: TextView
    private lateinit var signalsView: TextView
    private lateinit var slmStatus: TextView
    private lateinit var resultCard: LinearLayout
    private lateinit var advancedContainer: LinearLayout
    private lateinit var advancedToggle: Button
    private lateinit var rootScroll: android.widget.ScrollView
    private lateinit var resultStrip: View
    private lateinit var slmToggle: CompoundButton
    private lateinit var slmEndpoint: EditText
    private lateinit var radioOnDevice: RadioButton
    private lateinit var radioDevServer: RadioButton
    private lateinit var slmOnDeviceStatus: TextView
    private lateinit var smsToggle: CompoundButton
    private lateinit var smsStatus: TextView
    private lateinit var notifGuardToggle: CompoundButton
    private lateinit var notifGuardStatus: TextView
    private lateinit var defaultSmsStatus: TextView
    private lateinit var quarantineStatus: TextView
    private lateinit var guardLogStatus: TextView

    private var slmRun = 0

    private fun onDeviceModelFile() = File(getExternalFilesDir(null), "models/tantular.gguf")
    private fun onDeviceAdapterFile() = File(getExternalFilesDir(null), "models/tantular-lora.gguf")
    private fun onDeviceClassifier() = OnDeviceSlmClassifier(onDeviceModelFile(), onDeviceAdapterFile())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        input = findViewById(R.id.messageInput)
        verdictBanner = findViewById(R.id.verdictBanner)
        verdictMessage = findViewById(R.id.verdictMessage)
        signalsView = findViewById(R.id.signalsView)
        slmStatus = findViewById(R.id.slmStatus)
        resultCard = findViewById(R.id.resultCard)
        advancedContainer = findViewById(R.id.advancedContainer)
        advancedToggle = findViewById(R.id.advancedToggle)
        rootScroll = findViewById(R.id.rootScroll)
        resultStrip = findViewById(R.id.resultStrip)
        slmToggle = findViewById(R.id.slmToggle)
        slmEndpoint = findViewById(R.id.slmEndpoint)
        radioOnDevice = findViewById(R.id.radioOnDevice)
        radioDevServer = findViewById(R.id.radioDevServer)
        slmOnDeviceStatus = findViewById(R.id.slmOnDeviceStatus)
        smsToggle = findViewById(R.id.smsToggle)
        smsStatus = findViewById(R.id.smsStatus)
        notifGuardToggle = findViewById(R.id.notifGuardToggle)
        notifGuardStatus = findViewById(R.id.notifGuardStatus)
        defaultSmsStatus = findViewById(R.id.defaultSmsStatus)
        quarantineStatus = findViewById(R.id.quarantineStatus)
        guardLogStatus = findViewById(R.id.guardLogStatus)
        verdictMessage.movementMethod = LinkMovementMethod.getInstance()

        if (!BuildConfig.ALLOW_DEV_SERVER) {
            radioDevServer.visibility = View.GONE
        }
        restorePrefs()
        restoreAdvancedState()
        refreshSlmBackendUi()
        refreshSmsStatus()
        refreshNotifGuardStatus()
        refreshDefaultSmsStatus()
        refreshGuardLogStatus()

        findViewById<android.widget.RadioGroup>(R.id.slmBackendGroup)
            .setOnCheckedChangeListener { _, _ ->
                refreshSlmBackendUi()
                savePrefs()
            }
        slmToggle.setOnCheckedChangeListener { _, _ -> refreshSlmBackendUi() }

        findViewById<Button>(R.id.checkButton).setOnClickListener { evaluateCurrent() }
        findViewById<Button>(R.id.clearButton).setOnClickListener {
            input.setText("")
            resultCard.visibility = View.GONE
        }
        // One-tap flow for non-technical users: paste clipboard + check at once.
        findViewById<Button>(R.id.pasteCheckButton).setOnClickListener { pasteAndCheck() }
        // Tappable demo messages so testers can try the app without typing.
        findViewById<Button>(R.id.exampleOtpButton).setOnClickListener {
            fillAndCheck(getString(R.string.example_otp_text))
        }
        findViewById<Button>(R.id.examplePrizeButton).setOnClickListener {
            fillAndCheck(getString(R.string.example_prize_text))
        }
        findViewById<Button>(R.id.exampleNormalButton).setOnClickListener {
            fillAndCheck(getString(R.string.example_normal_text))
        }
        advancedToggle.setOnClickListener { toggleAdvanced() }
        findViewById<Button>(R.id.defaultSmsButton).setOnClickListener { requestDefaultSmsRole() }
        findViewById<Button>(R.id.latestQuarantineButton).setOnClickListener { openLatestQuarantine() }
        findViewById<Button>(R.id.clearQuarantineButton).setOnClickListener {
            SmsQuarantine.clear(this)
            refreshDefaultSmsStatus()
        }
        smsToggle.setOnCheckedChangeListener { _, checked ->
            prefs().edit().putBoolean(KEY_SMS_GUARD_ON, checked).apply()
            if (checked) requestSmsStage2Permissions()
            refreshSmsStatus()
        }
        notifGuardToggle.setOnCheckedChangeListener { _, checked ->
            prefs().edit().putBoolean(KEY_NOTIF_GUARD_ON, checked).apply()
            if (checked && !notificationAccessEnabled()) openNotificationAccessSettings()
            refreshNotifGuardStatus()
        }
        findViewById<Button>(R.id.notificationAccessButton).setOnClickListener { openNotificationAccessSettings() }
        findViewById<Button>(R.id.recoveryGuideButton).setOnClickListener { showRecoveryGuide() }
        findViewById<Button>(R.id.deviceRiskButton).setOnClickListener { showDeviceRiskChecklist() }
        findViewById<Button>(R.id.openWhatsappButton).setOnClickListener { openExternalApp("com.whatsapp") }
        findViewById<Button>(R.id.openWaBusinessButton).setOnClickListener { openExternalApp("com.whatsapp.w4b") }
        findViewById<Button>(R.id.viewGuardLogButton).setOnClickListener { showGuardLog() }
        findViewById<Button>(R.id.diagnosticsButton).setOnClickListener {
            startActivity(Intent(this, DiagnosticsActivity::class.java))
        }
        findViewById<Button>(R.id.clearGuardLogButton).setOnClickListener {
            GuardLog.clear(this)
            refreshGuardLogStatus()
            Toast.makeText(this, R.string.guard_log_cleared, Toast.LENGTH_SHORT).show()
        }

        handleSharedText(intent)
        handleCheckTextIntent(intent)
        handleSmsNotificationIntent(intent)
        handleQuarantineIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        refreshSmsStatus()
        refreshNotifGuardStatus()
        refreshDefaultSmsStatus()
        refreshGuardLogStatus()
    }

    override fun onPause() {
        super.onPause()
        savePrefs()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleSharedText(intent)
        handleCheckTextIntent(intent)
        handleSmsNotificationIntent(intent)
        handleQuarantineIntent(intent)
    }

    /** Accept text shared from SMS/WhatsApp/other apps via the system share sheet. */
    private fun handleSharedText(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            val shared = intent.getStringExtra(Intent.EXTRA_TEXT)
            if (!shared.isNullOrBlank()) {
                input.setText(shared)
                evaluateCurrent()
            }
        }
    }

    /** Opening a Guard Log entry loads the logged text back into the checker. */
    private fun handleCheckTextIntent(intent: Intent?) {
        val text = intent?.getStringExtra(EXTRA_CHECK_TEXT)
        if (!text.isNullOrBlank()) {
            input.setText(text)
            evaluateCurrent()
        }
    }

    /** Opening a Tantular warning notification loads the SMS into the checker. */
    private fun handleSmsNotificationIntent(intent: Intent?) {
        val smsText = intent?.getStringExtra(SmsReceiver.EXTRA_SMS_TEXT)
        if (!smsText.isNullOrBlank()) {
            input.setText(smsText)
            evaluateCurrent()
        }
    }

    /** Opening a quarantine notification loads the quarantined message into the checker. */
    private fun handleQuarantineIntent(intent: Intent?) {
        val id = intent?.getStringExtra(SmsQuarantine.EXTRA_QUARANTINE_ID) ?: return
        val item = SmsQuarantine.find(this, id) ?: return
        input.setText(item.body)
        evaluateCurrent()
    }

    /** Paste whatever is on the clipboard and check it in one tap. */
    private fun pasteAndCheck() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()?.trim().orEmpty()
        if (text.isEmpty()) {
            Toast.makeText(this, R.string.clipboard_empty, Toast.LENGTH_SHORT).show()
            return
        }
        fillAndCheck(text)
    }

    private fun fillAndCheck(text: String) {
        input.setText(text)
        evaluateCurrent()
    }

    private fun evaluateCurrent() {
        val text = input.text?.toString().orEmpty().trim()
        if (text.isEmpty()) {
            resultCard.visibility = View.GONE
            return
        }
        savePrefs()

        // Phase 1 — instant, offline, deterministic rules.
        val base = RiskScorer.evaluate(text, useModelStage = false)
        render(base)
        scrollToResult()

        // Phase 2 — optional SLM, only for borderline messages. Production
        // default is on-device. Dev-server/Ollama is explicit and opt-in.
        val runId = ++slmRun
        val shouldUseSlm = RiskScorer.shouldUseModelStage(text)
        if (!slmToggle.isChecked) {
            slmStatus.text = getString(R.string.slm_off)
            return
        }
        if (!shouldUseSlm) {
            slmStatus.text = getString(R.string.slm_not_needed)
            return
        }

        val classifier: SlmClassifier = currentSlmClassifier()
        slmStatus.text = getString(R.string.slm_checking_with_backend, classifier.name)
        Thread {
            val result = classifier.classify(text)
            runOnUiThread {
                if (isFinishing || runId != slmRun) return@runOnUiThread
                if (result.ok) {
                    val fused = RiskScorer.evaluate(text, useModelStage = false, slmLabel = result.label)
                    render(fused)
                    slmStatus.text = getString(
                        R.string.slm_used_format,
                        result.backend,
                        result.label.name,
                        result.latencyMs,
                    )
                } else {
                    slmStatus.text = getString(R.string.slm_error_format, result.backend, result.error ?: "?")
                }
            }
        }.start()
    }

    private fun render(result: RiskScorer.GuardVerdict) {
        val color = when (result.verdict) {
            RiskScorer.Verdict.BLOCK -> Color.parseColor("#B91C1C")
            RiskScorer.Verdict.WARN -> Color.parseColor("#B45E00")
            RiskScorer.Verdict.ALLOW -> Color.parseColor("#15803D")
        }
        val bg = when (result.verdict) {
            RiskScorer.Verdict.BLOCK -> Color.parseColor("#FEF2F2")
            RiskScorer.Verdict.WARN -> Color.parseColor("#FFFBEB")
            RiskScorer.Verdict.ALLOW -> Color.parseColor("#F0FDF4")
        }

        resultCard.visibility = View.VISIBLE
        resultCard.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 18f * resources.displayMetrics.density
            setColor(bg)
            setStroke((1f * resources.displayMetrics.density).toInt(), Color.parseColor("#DAE2EC"))
        }
        resultStrip.setBackgroundColor(color)
        verdictBanner.setTextColor(color)
        verdictBanner.text = getString(
            R.string.verdict_banner_format,
            verdictBadge(result.verdict),
            RiskScorer.riskLevelLabel(result.verdict),
            result.bannerTitle,
        )
        verdictMessage.text = if (result.accountTakeover && result.takeoverAdvice != null) {
            result.userMessage + "\n\n" + result.takeoverAdvice
        } else {
            result.userMessage
        }
        signalsView.text = if (result.matchedSignals.isEmpty()) {
            getString(R.string.signals_none)
        } else {
            getString(
                R.string.signals_format,
                RiskScorer.humanSignals(result.matchedSignals).joinToString("\n") { "• $it" },
            )
        }
    }

    private fun toggleAdvanced() {
        val show = advancedContainer.visibility != View.VISIBLE
        advancedContainer.visibility = if (show) View.VISIBLE else View.GONE
        advancedToggle.text = getString(if (show) R.string.advanced_hide else R.string.advanced_show)
        prefs().edit().putBoolean(KEY_ADVANCED_OPEN, show).apply()
    }

    private fun restoreAdvancedState() {
        val show = prefs().getBoolean(KEY_ADVANCED_OPEN, false)
        advancedContainer.visibility = if (show) View.VISIBLE else View.GONE
        advancedToggle.text = getString(if (show) R.string.advanced_hide else R.string.advanced_show)
    }

    private fun scrollToResult() {
        resultCard.post {
            rootScroll.smoothScrollTo(0, resultCard.top - (16f * resources.displayMetrics.density).toInt())
        }
    }

    private fun currentEndpoint(): String {
        val typed = slmEndpoint.text?.toString()?.trim().orEmpty()
        return typed.ifEmpty { getString(R.string.slm_default_endpoint) }
    }

    private fun verdictLabel(verdict: RiskScorer.Verdict): String = when (verdict) {
        RiskScorer.Verdict.BLOCK -> getString(R.string.verdict_block)
        RiskScorer.Verdict.WARN -> getString(R.string.verdict_warn)
        RiskScorer.Verdict.ALLOW -> getString(R.string.verdict_allow)
    }

    private fun verdictBadge(verdict: RiskScorer.Verdict): String = when (verdict) {
        RiskScorer.Verdict.BLOCK -> "\uD83D\uDED1 " + getString(R.string.verdict_block)
        RiskScorer.Verdict.WARN -> "\u26A0\uFE0F " + getString(R.string.verdict_warn)
        RiskScorer.Verdict.ALLOW -> "\u2705 " + getString(R.string.verdict_allow)
    }

    private fun currentSlmClassifier(): SlmClassifier = if (radioDevServer.isChecked) {
        OllamaSlmClassifier(currentEndpoint(), getString(R.string.slm_model))
    } else {
        onDeviceClassifier()
    }

    private fun refreshSlmBackendUi() {
        slmEndpoint.visibility = if (radioDevServer.isChecked) View.VISIBLE else View.GONE
        slmOnDeviceStatus.visibility = if (radioOnDevice.isChecked) View.VISIBLE else View.GONE
        val classifier = onDeviceClassifier()
        slmOnDeviceStatus.text = when {
            NativeLlama.AVAILABLE && classifier.modelPresent() -> getString(R.string.slm_ondevice_ready)
            classifier.modelPresent() -> getString(R.string.slm_ondevice_runtime_missing)
            else -> getString(R.string.slm_ondevice_missing)
        }
    }

    private fun prefs() = getSharedPreferences("tantular_guard", Context.MODE_PRIVATE)

    private fun restorePrefs() {
        val p = prefs()
        slmToggle.isChecked = p.getBoolean(KEY_SLM_ON, false)
        slmEndpoint.setText(p.getString("slm_endpoint", getString(R.string.slm_default_endpoint)))
        if (BuildConfig.ALLOW_DEV_SERVER && p.getString(KEY_SLM_BACKEND, SLM_BACKEND_ON_DEVICE) == SLM_BACKEND_DEV_SERVER) {
            radioDevServer.isChecked = true
        } else {
            radioOnDevice.isChecked = true
        }
        smsToggle.isChecked = p.getBoolean(KEY_SMS_GUARD_ON, false)
        notifGuardToggle.isChecked = p.getBoolean(KEY_NOTIF_GUARD_ON, false)
    }

    private fun savePrefs() {
        prefs().edit()
            .putBoolean(KEY_SLM_ON, slmToggle.isChecked)
            .putString("slm_endpoint", currentEndpoint())
            .putString(KEY_SLM_BACKEND, if (BuildConfig.ALLOW_DEV_SERVER && radioDevServer.isChecked) SLM_BACKEND_DEV_SERVER else SLM_BACKEND_ON_DEVICE)
            .putBoolean(KEY_SMS_GUARD_ON, smsToggle.isChecked)
            .putBoolean(KEY_NOTIF_GUARD_ON, notifGuardToggle.isChecked)
            .apply()
    }

    private fun requestSmsStage2Permissions() {
        val permissions = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.RECEIVE_SMS)
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (permissions.isNotEmpty()) {
            requestPermissions(permissions.toTypedArray(), REQ_SMS_STAGE2)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_SMS_STAGE2) {
            refreshSmsStatus()
        }
    }

    private fun refreshSmsStatus() {
        val smsGranted = Build.VERSION.SDK_INT < 23 ||
            checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        val notifGranted = Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        smsStatus.text = when {
            !smsToggle.isChecked -> getString(R.string.sms_guard_off)
            smsGranted && notifGranted -> getString(R.string.sms_guard_ready)
            !smsGranted -> getString(R.string.sms_guard_need_sms_permission)
            else -> getString(R.string.sms_guard_need_notification_permission)
        }
    }


    private fun refreshGuardLogStatus() {
        val count = GuardLog.count(this)
        guardLogStatus.text = if (count == 0) {
            getString(R.string.guard_log_empty)
        } else {
            getString(R.string.guard_log_count_format, count)
        }
    }

    private fun showGuardLog() {
        startActivity(Intent(this, GuardLogActivity::class.java))
    }

    private fun notificationAccessEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        return enabled.split(':').any { it.contains(packageName, ignoreCase = true) }
    }

    private fun refreshNotifGuardStatus() {
        val enabled = notifGuardToggle.isChecked
        val access = notificationAccessEnabled()
        notifGuardStatus.text = when {
            !enabled -> getString(R.string.notif_guard_off)
            access -> getString(R.string.notif_guard_ready) + "\n" + getString(R.string.notif_guard_privacy)
            else -> getString(R.string.notif_guard_need_access) + "\n" + getString(R.string.notif_guard_privacy)
        }
    }

    private fun openNotificationAccessSettings() {
        startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    }

    private fun showRecoveryGuide() {
        AlertDialog.Builder(this)
            .setTitle(R.string.recovery_dialog_title)
            .setMessage(RiskScorer.recoveryChecklist("WhatsApp / WhatsApp Business / media sosial"))
            .setPositiveButton(R.string.close, null)
            .show()
    }

    private fun showDeviceRiskChecklist() {
        val items = arrayOf(
            getString(R.string.device_risk_accessibility) to Settings.ACTION_ACCESSIBILITY_SETTINGS,
            getString(R.string.device_risk_notification) to Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS,
            getString(R.string.device_risk_admin) to Settings.ACTION_SECURITY_SETTINGS,
            getString(R.string.device_risk_unknown_sources) to Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            getString(R.string.device_risk_overlay) to Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        )
        AlertDialog.Builder(this)
            .setTitle(R.string.device_risk_dialog_title)
            .setMessage(getString(R.string.device_risk_intro))
            .setItems(items.map { it.first }.toTypedArray()) { _, which ->
                runCatching { startActivity(Intent(items[which].second)) }
            }
            .setPositiveButton(R.string.close, null)
            .show()
    }

    private fun openExternalApp(packageName: String) {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        if (launch != null) {
            runCatching { startActivity(launch) }
                .onFailure { Toast.makeText(this, R.string.app_not_installed, Toast.LENGTH_SHORT).show() }
        } else {
            Toast.makeText(this, R.string.app_not_installed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun isDefaultSmsApp(): Boolean =
        Telephony.Sms.getDefaultSmsPackage(this) == packageName

    private fun refreshDefaultSmsStatus() {
        defaultSmsStatus.text = if (isDefaultSmsApp()) {
            getString(R.string.default_sms_ready)
        } else {
            getString(R.string.default_sms_not_ready)
        }
        val count = SmsQuarantine.count(this)
        val latest = SmsQuarantine.latest(this)
        quarantineStatus.text = if (count == 0 || latest == null) {
            getString(R.string.quarantine_empty)
        } else {
            getString(R.string.quarantine_count_format, count, latest.verdict, latest.riskScore)
        }
    }

    private fun requestDefaultSmsRole() {
        if (Build.VERSION.SDK_INT >= 29) {
            val roleManager = getSystemService(RoleManager::class.java)
            if (roleManager != null && roleManager.isRoleAvailable(RoleManager.ROLE_SMS)) {
                val launched = runCatching {
                    startActivityForResult(roleManager.createRequestRoleIntent(RoleManager.ROLE_SMS), REQ_DEFAULT_SMS)
                }.isSuccess
                if (launched) return
            }
        }
        @Suppress("DEPRECATION")
        val intent = Intent(Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT).apply {
            putExtra(Telephony.Sms.Intents.EXTRA_PACKAGE_NAME, packageName)
        }
        val ok = runCatching { startActivityForResult(intent, REQ_DEFAULT_SMS) }.isSuccess
        if (!ok) openDefaultAppsSettings()
    }

    /**
     * Samsung/OneUI sometimes dismisses the role dialog without showing it.
     * Send the user to the system Default-apps screen so they can pick
     * Tantular manually: Pengaturan > Aplikasi default > Aplikasi SMS.
     */
    private fun openDefaultAppsSettings() {
        Toast.makeText(this, R.string.default_sms_manual_hint, Toast.LENGTH_LONG).show()
        runCatching {
            startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
        }.onFailure {
            runCatching { startActivity(Intent(Settings.ACTION_SETTINGS)) }
        }
    }

    @Deprecated("Deprecated by Activity, still needed for default-SMS role fallback result.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_DEFAULT_SMS) {
            refreshDefaultSmsStatus()
            // Role dialog denied/auto-dismissed (common on OneUI): guide the
            // user to the manual path instead of failing silently.
            if (!isDefaultSmsApp()) openDefaultAppsSettings()
        }
    }

    private fun openLatestQuarantine() {
        val latest = SmsQuarantine.latest(this) ?: return
        input.setText(latest.body)
        evaluateCurrent()
    }

    companion object {
        const val KEY_SMS_GUARD_ON = "sms_guard_on"
        const val KEY_NOTIF_GUARD_ON = "notif_guard_on"
        const val KEY_SLM_ON = "slm_on"
        const val KEY_SLM_BACKEND = "slm_backend"
        const val SLM_BACKEND_ON_DEVICE = "on_device"
        const val SLM_BACKEND_DEV_SERVER = "dev_server"
        const val EXTRA_CHECK_TEXT = "ai.sakana.tantularguard.extra.CHECK_TEXT"
        private const val KEY_ADVANCED_OPEN = "advanced_open"
        private const val REQ_SMS_STAGE2 = 2202
        private const val REQ_DEFAULT_SMS = 2302
    }
}
