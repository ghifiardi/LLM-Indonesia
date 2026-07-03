package ai.sakana.tantularguard

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.method.LinkMovementMethod
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Tantular Guard.
 *
 * Two ways to check a message:
 *   1. paste text into the box and tap "Periksa Pesan"
 *   2. share a message from SMS/WhatsApp/etc. into this app (ACTION_SEND)
 *
 * Verdict flow:
 *   text -> [RiskScorer] deterministic rules (offline, instant)
 *        -> if borderline AND the Tantular SLM toggle is on, an async call to a
 *           user-configured Ollama server re-fuses the verdict. The SLM can only
 *           escalate; the rules stay the hard safety floor.
 */
class MainActivity : Activity() {

    private lateinit var input: EditText
    private lateinit var verdictBanner: TextView
    private lateinit var verdictMessage: TextView
    private lateinit var signalsView: TextView
    private lateinit var slmStatus: TextView
    private lateinit var resultCard: LinearLayout
    private lateinit var slmToggle: CheckBox
    private lateinit var slmEndpoint: EditText

    private var slmRun = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        input = findViewById(R.id.messageInput)
        verdictBanner = findViewById(R.id.verdictBanner)
        verdictMessage = findViewById(R.id.verdictMessage)
        signalsView = findViewById(R.id.signalsView)
        slmStatus = findViewById(R.id.slmStatus)
        resultCard = findViewById(R.id.resultCard)
        slmToggle = findViewById(R.id.slmToggle)
        slmEndpoint = findViewById(R.id.slmEndpoint)
        verdictMessage.movementMethod = LinkMovementMethod.getInstance()

        restorePrefs()

        findViewById<Button>(R.id.checkButton).setOnClickListener { evaluateCurrent() }
        findViewById<Button>(R.id.clearButton).setOnClickListener {
            input.setText("")
            resultCard.visibility = View.GONE
        }

        handleSharedText(intent)
    }

    override fun onPause() {
        super.onPause()
        savePrefs()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleSharedText(intent)
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

    private fun evaluateCurrent() {
        val text = input.text?.toString().orEmpty().trim()
        if (text.isEmpty()) {
            resultCard.visibility = View.GONE
            return
        }
        savePrefs()

        // Phase 1 — instant, offline, deterministic (stub SLM stage).
        val base = RiskScorer.evaluate(text)
        render(base)

        // Phase 2 — optional real SLM, only for borderline messages.
        val runId = ++slmRun
        if (slmToggle.isChecked && base.modelStageUsed) {
            slmStatus.text = getString(R.string.slm_checking)
            val endpoint = currentEndpoint()
            val model = getString(R.string.slm_model)
            Thread {
                val result = OllamaSlmClassifier(endpoint, model).classify(text)
                runOnUiThread {
                    if (isFinishing || runId != slmRun) return@runOnUiThread
                    if (result.ok) {
                        val fused = RiskScorer.evaluate(text, slmLabel = result.label)
                        render(fused)
                        slmStatus.text = getString(
                            R.string.slm_used_format,
                            result.backend,
                            result.label.name,
                            result.latencyMs,
                        )
                    } else {
                        slmStatus.text = getString(R.string.slm_error_format, result.error ?: "?")
                    }
                }
            }.start()
        } else {
            slmStatus.text = getString(R.string.slm_off)
        }
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
        verdictBanner.setTextColor(color)
        verdictBanner.text = getString(
            R.string.verdict_banner_format,
            result.verdict.name,
            result.riskScore,
            result.bannerTitle,
        )
        verdictMessage.text = result.userMessage
        signalsView.text = if (result.matchedSignals.isEmpty()) {
            getString(R.string.signals_none)
        } else {
            getString(R.string.signals_format, result.matchedSignals.joinToString(", "))
        }
    }

    private fun currentEndpoint(): String {
        val typed = slmEndpoint.text?.toString()?.trim().orEmpty()
        return typed.ifEmpty { getString(R.string.slm_default_endpoint) }
    }

    private fun prefs() = getSharedPreferences("tantular_guard", Context.MODE_PRIVATE)

    private fun restorePrefs() {
        val p = prefs()
        slmToggle.isChecked = p.getBoolean("slm_on", false)
        slmEndpoint.setText(p.getString("slm_endpoint", getString(R.string.slm_default_endpoint)))
    }

    private fun savePrefs() {
        prefs().edit()
            .putBoolean("slm_on", slmToggle.isChecked)
            .putString("slm_endpoint", currentEndpoint())
            .apply()
    }
}
