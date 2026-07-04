package ai.sakana.tantularguard

import android.app.Activity
import android.app.AlertDialog
import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
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
import android.widget.ProgressBar
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
    private lateinit var privacyShieldCard: LinearLayout
    private lateinit var privacyShieldSummary: TextView
    private lateinit var redactedPreview: TextView
    private lateinit var messageSenseCard: LinearLayout
    private lateinit var messageSenseSummary: TextView
    private lateinit var messageSenseItems: TextView
    private lateinit var messageSenseActions: TextView
    private var latestRedaction: PiiRedactor.Result? = null
    private var latestTriage: MessageTriage.Result? = null
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
    private lateinit var digestToggle: CompoundButton
    private lateinit var digestStatus: TextView
    private lateinit var gameLevel: TextView
    private lateinit var gameProgress: ProgressBar
    private lateinit var gameStats: TextView
    private lateinit var missionFirst: TextView
    private lateinit var missionFive: TextView
    private lateinit var missionSms: TextView
    private lateinit var missionNotif: TextView

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
        privacyShieldCard = findViewById(R.id.privacyShieldCard)
        privacyShieldSummary = findViewById(R.id.privacyShieldSummary)
        redactedPreview = findViewById(R.id.redactedPreview)
        messageSenseCard = findViewById(R.id.messageSenseCard)
        messageSenseSummary = findViewById(R.id.messageSenseSummary)
        messageSenseItems = findViewById(R.id.messageSenseItems)
        messageSenseActions = findViewById(R.id.messageSenseActions)
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
        digestToggle = findViewById(R.id.digestToggle)
        digestStatus = findViewById(R.id.digestStatus)
        gameLevel = findViewById(R.id.gameLevel)
        gameProgress = findViewById(R.id.gameProgress)
        gameStats = findViewById(R.id.gameStats)
        missionFirst = findViewById(R.id.missionFirst)
        missionFive = findViewById(R.id.missionFive)
        missionSms = findViewById(R.id.missionSms)
        missionNotif = findViewById(R.id.missionNotif)
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
        refreshGameCard()

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
        findViewById<Button>(R.id.copyRedactedButton).setOnClickListener { copyRedacted() }
        findViewById<Button>(R.id.copyTriageButton).setOnClickListener { copyTriage() }
        findViewById<Button>(R.id.defaultSmsButton).setOnClickListener { requestDefaultSmsRole() }
        findViewById<Button>(R.id.latestQuarantineButton).setOnClickListener { openLatestQuarantine() }
        findViewById<Button>(R.id.clearQuarantineButton).setOnClickListener {
            SmsQuarantine.clear(this)
            refreshDefaultSmsStatus()
        }
        smsToggle.setOnCheckedChangeListener { _, checked ->
            prefs().edit().putBoolean(KEY_SMS_GUARD_ON, checked).apply()
            if (checked && smsPermissionsMissing()) {
                // Explain BEFORE Android's scary system prompt, so users know
                // what they're agreeing to (and denials stop being reflexive).
                AlertDialog.Builder(this)
                    .setTitle(R.string.perm_sms_title)
                    .setMessage(R.string.perm_sms_body)
                    .setPositiveButton(R.string.perm_continue) { _, _ -> requestSmsStage2Permissions() }
                    .setNegativeButton(R.string.perm_cancel) { _, _ -> smsToggle.isChecked = false }
                    .setOnCancelListener { smsToggle.isChecked = false }
                    .show()
            }
            refreshSmsStatus()
            refreshGameCard()
        }
        notifGuardToggle.setOnCheckedChangeListener { _, checked ->
            prefs().edit().putBoolean(KEY_NOTIF_GUARD_ON, checked).apply()
            if (checked && !notificationAccessEnabled()) {
                AlertDialog.Builder(this)
                    .setTitle(R.string.perm_notif_access_title)
                    .setMessage(R.string.perm_notif_access_body)
                    .setPositiveButton(R.string.perm_open_settings) { _, _ -> openNotificationAccessSettings() }
                    .setNegativeButton(R.string.perm_cancel) { _, _ -> notifGuardToggle.isChecked = false }
                    .setOnCancelListener { notifGuardToggle.isChecked = false }
                    .show()
            }
            refreshNotifGuardStatus()
            refreshGameCard()
        }
        digestToggle.setOnCheckedChangeListener { _, checked ->
            prefs().edit().putBoolean(KEY_DIGEST_ON, checked).apply()
            if (checked && !notificationAccessEnabled()) {
                AlertDialog.Builder(this)
                    .setTitle(R.string.perm_notif_access_title)
                    .setMessage(R.string.perm_digest_body)
                    .setPositiveButton(R.string.perm_open_settings) { _, _ -> openNotificationAccessSettings() }
                    .setNegativeButton(R.string.perm_cancel) { _, _ -> digestToggle.isChecked = false }
                    .setOnCancelListener { digestToggle.isChecked = false }
                    .show()
            }
            refreshDigestStatus()
        }
        findViewById<Button>(R.id.viewDigestButton).setOnClickListener {
            startActivity(Intent(this, NotificationDigestActivity::class.java))
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
        findViewById<Button>(R.id.howToUseButton).setOnClickListener {
            startActivity(Intent(this, OnboardingActivity::class.java))
        }
        // "What does this feature actually do?" popups on every section header.
        wireInfoPopup(R.id.infoProtection, R.string.info_protection_title, R.string.info_protection_body)
        wireInfoPopup(R.id.infoAccount, R.string.info_account_title, R.string.info_account_body)
        wireInfoPopup(R.id.infoHistory, R.string.info_history_title, R.string.info_history_body)
        wireInfoPopup(R.id.infoAi, R.string.info_ai_title, R.string.info_ai_body)
        wireInfoPopup(R.id.infoWa, R.string.info_wa_title, R.string.info_wa_body)
        wireInfoPopup(R.id.infoQuarantine, R.string.info_quarantine_title, R.string.info_quarantine_body)
        wireInfoPopup(R.id.infoDigest, R.string.info_digest_title, R.string.info_digest_body)

        handleSharedText(intent)
        handleCheckTextIntent(intent)
        handleSmsNotificationIntent(intent)
        handleQuarantineIntent(intent)
        handleRunExampleIntent(intent)

        // First launch: show step-by-step guidance instead of an empty screen.
        // Skip when the app was opened to do something (share/notification/etc.)
        // so onboarding never blocks a real task.
        if (!prefs().getBoolean(OnboardingActivity.KEY_ONBOARDING_DONE, false) && !openedWithTask(intent)) {
            startActivity(Intent(this, OnboardingActivity::class.java))
        }
    }

    /** Update the Misi Keamanan card: missions, score bar, level, stats. */
    private fun refreshGameCard() {
        val p = prefs()
        val checks = p.getInt(GameState.KEY_CHECK_COUNT, 0)
        val blocks = p.getInt(GameState.KEY_BLOCK_COUNT, 0)
        val missions = GameState.Missions(
            firstCheck = checks >= 1,
            smsGuardOn = p.getBoolean(KEY_SMS_GUARD_ON, false) && !smsPermissionsMissing(),
            notifGuardOn = p.getBoolean(KEY_NOTIF_GUARD_ON, false) && notificationAccessEnabled(),
            fiveChecks = checks >= GameState.FIVE_CHECKS_TARGET,
        )
        val score = GameState.score(missions)

        gameLevel.text = getString(R.string.game_level_format, GameState.levelName(score), score)
        if (Build.VERSION.SDK_INT >= 24) gameProgress.setProgress(score, true) else gameProgress.progress = score
        gameStats.text = getString(R.string.game_stats_format, checks, blocks)

        fun mark(done: Boolean, label: String) = (if (done) "✅ " else "⬜ ") + label
        missionFirst.text = mark(missions.firstCheck, getString(R.string.mission_first))
        missionFive.text = mark(
            missions.fiveChecks,
            getString(R.string.mission_five, checks.coerceAtMost(GameState.FIVE_CHECKS_TARGET)),
        )
        missionSms.text = mark(missions.smsGuardOn, getString(R.string.mission_sms))
        missionNotif.text = mark(missions.notifGuardOn, getString(R.string.mission_notif))

        // Celebrate score increases exactly once per new high.
        val celebrated = p.getInt(GameState.KEY_CELEBRATED_SCORE, 0)
        if (score > celebrated) {
            Toast.makeText(
                this,
                getString(R.string.game_score_up, GameState.levelName(score)),
                Toast.LENGTH_LONG,
            ).show()
        }
        if (score != celebrated) {
            p.edit().putInt(GameState.KEY_CELEBRATED_SCORE, score).apply()
        }
    }

    /** Attach a plain-language "what does this do?" dialog to an ℹ️ header icon. */
    private fun wireInfoPopup(viewId: Int, titleRes: Int, bodyRes: Int) {
        findViewById<TextView>(viewId).setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle(titleRes)
                .setMessage(bodyRes)
                .setPositiveButton(R.string.close, null)
                .show()
        }
    }

    /** True when the app was opened via share sheet, notification, or deep link. */
    private fun openedWithTask(intent: Intent?): Boolean =
        intent?.action == Intent.ACTION_SEND ||
            intent?.action == Intent.ACTION_SENDTO ||
            intent?.hasExtra(EXTRA_CHECK_TEXT) == true ||
            intent?.hasExtra(EXTRA_RUN_EXAMPLE) == true ||
            intent?.hasExtra(SmsReceiver.EXTRA_SMS_TEXT) == true ||
            intent?.hasExtra(SmsQuarantine.EXTRA_QUARANTINE_ID) == true

    /** Onboarding's "Coba dengan contoh" lands here: run the OTP example at once. */
    private fun handleRunExampleIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_RUN_EXAMPLE, false) == true) {
            intent.removeExtra(EXTRA_RUN_EXAMPLE)
            fillAndCheck(getString(R.string.example_otp_text))
        }
    }

    override fun onResume() {
        super.onResume()
        refreshSmsStatus()
        refreshNotifGuardStatus()
        refreshDefaultSmsStatus()
        refreshGuardLogStatus()
        refreshDigestStatus()
        refreshGameCard()
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
        handleRunExampleIntent(intent)
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
            privacyShieldCard.visibility = View.GONE
            messageSenseCard.visibility = View.GONE
            latestRedaction = null
            latestTriage = null
            return
        }
        savePrefs()

        // Phase 1 — instant, offline, deterministic rules.
        val base = RiskScorer.evaluate(text, useModelStage = false)
        render(base)
        renderPrivacyShield(text)
        renderMessageSense(text, base)
        scrollToResult()

        // Gamification counters: every check counts; catching a scam counts double fun.
        prefs().edit()
            .putInt(GameState.KEY_CHECK_COUNT, prefs().getInt(GameState.KEY_CHECK_COUNT, 0) + 1)
            .apply()
        if (base.verdict == RiskScorer.Verdict.BLOCK) {
            prefs().edit()
                .putInt(GameState.KEY_BLOCK_COUNT, prefs().getInt(GameState.KEY_BLOCK_COUNT, 0) + 1)
                .apply()
        }
        refreshGameCard()

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
                    renderMessageSense(text, fused)
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

    private fun renderPrivacyShield(text: String) {
        val result = PiiRedactor.redact(text)
        latestRedaction = result
        privacyShieldCard.visibility = View.VISIBLE
        privacyShieldSummary.text = result.summary()
        redactedPreview.text = result.redactedText
    }

    private fun renderMessageSense(text: String, verdict: RiskScorer.GuardVerdict) {
        val result = MessageTriage.analyze(text, verdict)
        latestTriage = result
        messageSenseCard.visibility = View.VISIBLE
        messageSenseSummary.text = result.summary
        messageSenseItems.text = getString(R.string.message_sense_items_prefix) + "\n" +
            if (result.items.isEmpty()) getString(R.string.message_sense_no_items)
            else result.items.joinToString("\n") { "• ${it.label}: ${it.value}" }
        messageSenseActions.text = getString(R.string.message_sense_actions_prefix) + "\n" +
            result.actions.joinToString("\n") { "• $it" }
    }

    private fun copyRedacted() {
        val text = latestRedaction?.redactedText ?: return
        copyToClipboard("Tantular", text)
    }

    private fun copyTriage() {
        val result = latestTriage ?: return
        val text = result.summary + "\n" + result.actions.joinToString("\n") { "• $it" }
        copyToClipboard("Tantular", text)
    }

    private fun copyToClipboard(label: String, text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
        Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show()
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
        digestToggle.isChecked = p.getBoolean(KEY_DIGEST_ON, false)
    }

    private fun savePrefs() {
        prefs().edit()
            .putBoolean(KEY_SLM_ON, slmToggle.isChecked)
            .putString("slm_endpoint", currentEndpoint())
            .putString(KEY_SLM_BACKEND, if (BuildConfig.ALLOW_DEV_SERVER && radioDevServer.isChecked) SLM_BACKEND_DEV_SERVER else SLM_BACKEND_ON_DEVICE)
            .putBoolean(KEY_SMS_GUARD_ON, smsToggle.isChecked)
            .putBoolean(KEY_NOTIF_GUARD_ON, notifGuardToggle.isChecked)
            .putBoolean(KEY_DIGEST_ON, digestToggle.isChecked)
            .apply()
    }

    private fun smsPermissionsMissing(): Boolean {
        val smsMissing = Build.VERSION.SDK_INT >= 23 &&
            checkSelfPermission(Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED
        val notifMissing = Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        return smsMissing || notifMissing
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

    private fun refreshDigestStatus() {
        val on = digestToggle.isChecked
        val access = notificationAccessEnabled()
        digestStatus.text = when {
            !on -> getString(R.string.digest_off)
            !access -> getString(R.string.digest_need_access)
            else -> {
                val n = NotificationDigestStore.countToday(this)
                if (n == 0) getString(R.string.digest_ready) else getString(R.string.digest_count_today, n)
            }
        }
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
        const val KEY_DIGEST_ON = "digest_on"
        const val KEY_DIGEST_IMPORTANT_ONLY = "digest_important_only"
        const val KEY_SLM_ON = "slm_on"
        const val KEY_SLM_BACKEND = "slm_backend"
        const val SLM_BACKEND_ON_DEVICE = "on_device"
        const val SLM_BACKEND_DEV_SERVER = "dev_server"
        const val EXTRA_CHECK_TEXT = "ai.sakana.tantularguard.extra.CHECK_TEXT"
        const val EXTRA_RUN_EXAMPLE = "ai.sakana.tantularguard.extra.RUN_EXAMPLE"
        private const val KEY_ADVANCED_OPEN = "advanced_open"
        private const val REQ_SMS_STAGE2 = 2202
        private const val REQ_DEFAULT_SMS = 2302
    }
}
