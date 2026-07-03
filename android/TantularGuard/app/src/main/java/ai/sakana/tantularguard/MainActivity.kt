package ai.sakana.tantularguard

import android.content.Intent
import android.graphics.Color
import android.app.Activity
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.method.LinkMovementMethod
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Tantular Guard — Stage 1.
 *
 * Two ways to check a message, both fully on-device:
 *   1. paste text into the box and tap "Periksa Pesan"
 *   2. share a message from SMS/WhatsApp/etc. into this app (ACTION_SEND)
 *
 * The verdict (BLOCK / WARN / ALLOW) comes from [RiskScorer], which never sends
 * the message anywhere.
 */
class MainActivity : Activity() {

    private lateinit var input: EditText
    private lateinit var verdictBanner: TextView
    private lateinit var verdictMessage: TextView
    private lateinit var signalsView: TextView
    private lateinit var resultCard: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        input = findViewById(R.id.messageInput)
        verdictBanner = findViewById(R.id.verdictBanner)
        verdictMessage = findViewById(R.id.verdictMessage)
        signalsView = findViewById(R.id.signalsView)
        resultCard = findViewById(R.id.resultCard)
        verdictMessage.movementMethod = LinkMovementMethod.getInstance()

        findViewById<Button>(R.id.checkButton).setOnClickListener { evaluateCurrent() }
        findViewById<Button>(R.id.clearButton).setOnClickListener {
            input.setText("")
            resultCard.visibility = View.GONE
        }

        handleSharedText(intent)
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

        val result = RiskScorer.evaluate(text)

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
}
