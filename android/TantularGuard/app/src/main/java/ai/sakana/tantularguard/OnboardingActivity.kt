package ai.sakana.tantularguard

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * First-launch, step-by-step guidance for non-technical users.
 *
 * Three short pages in plain Indonesian:
 *   1. what Tantular Guard is (and that nothing leaves the phone),
 *   2. how to check a message (copy -> paste & check, or share from WhatsApp),
 *   3. what the three verdict colors mean,
 * ending with "Coba dengan contoh" which returns to MainActivity and runs the
 * OTP-scam example immediately — the fastest possible aha-moment.
 *
 * Shown automatically once (prefs flag) and reopenable anytime from the
 * "Cara pakai" button on the home screen.
 */
class OnboardingActivity : Activity() {

    private var step = 0

    private lateinit var emojiView: TextView
    private lateinit var titleView: TextView
    private lateinit var bodyView: TextView
    private lateinit var dotsView: TextView
    private lateinit var backButton: Button
    private lateinit var nextButton: Button
    private lateinit var tryButton: Button
    private lateinit var skipButton: Button

    private data class Page(val emoji: String, val title: String, val body: String)

    private val pages by lazy {
        listOf(
            Page(
                "🛡️", // shield
                getString(R.string.onboarding_1_title),
                getString(R.string.onboarding_1_body),
            ),
            Page(
                "📋", // clipboard
                getString(R.string.onboarding_2_title),
                getString(R.string.onboarding_2_body),
            ),
            Page(
                "🚦", // traffic light
                getString(R.string.onboarding_3_title),
                getString(R.string.onboarding_3_body),
            ),
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        render()
    }

    private fun buildUi(): View {
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0F2547")) // navy
            setPadding(dp(28), dp(48), dp(28), dp(28))
        }

        skipButton = Button(this).apply {
            text = getString(R.string.onboarding_skip)
            isAllCaps = false
            setTextColor(Color.parseColor("#93ADD3"))
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { finishOnboarding(runExample = false) }
        }
        root.addView(skipButton, LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.END })

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }

        emojiView = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 64f)
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(20))
        }
        content.addView(emojiView)

        titleView = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        content.addView(titleView)

        bodyView = TextView(this).apply {
            setTextColor(Color.parseColor("#CBD5E1"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            setLineSpacing(0f, 1.35f)
            gravity = Gravity.CENTER
            setPadding(dp(4), dp(16), dp(4), 0)
        }
        content.addView(bodyView)

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            addView(content, LinearLayout.LayoutParams(MATCH, WRAP))
        }
        root.addView(scroll, LinearLayout.LayoutParams(MATCH, 0, 1f))

        dotsView = TextView(this).apply {
            setTextColor(Color.parseColor("#93ADD3"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(16))
        }
        root.addView(dotsView, LinearLayout.LayoutParams(MATCH, WRAP))

        tryButton = Button(this).apply {
            text = getString(R.string.onboarding_try_example)
            isAllCaps = false
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            minHeight = dp(54)
            background = pill(Color.parseColor("#16A34A"), dp(14).toFloat())
            setOnClickListener { finishOnboarding(runExample = true) }
        }
        root.addView(tryButton, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(10) })

        val nav = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        backButton = Button(this).apply {
            text = getString(R.string.onboarding_back)
            isAllCaps = false
            setTextColor(Color.parseColor("#CBD5E1"))
            minHeight = dp(50)
            background = pill(Color.parseColor("#1E3A66"), dp(14).toFloat())
            setOnClickListener { step = (step - 1).coerceAtLeast(0); render() }
        }
        nextButton = Button(this).apply {
            text = getString(R.string.onboarding_next)
            isAllCaps = false
            setTextColor(Color.parseColor("#0F2547"))
            setTypeface(typeface, Typeface.BOLD)
            minHeight = dp(50)
            background = pill(Color.WHITE, dp(14).toFloat())
            setOnClickListener {
                if (step < pages.size - 1) { step++; render() } else finishOnboarding(runExample = false)
            }
        }
        nav.addView(backButton, LinearLayout.LayoutParams(0, WRAP, 1f))
        nav.addView(View(this), LinearLayout.LayoutParams(dp(10), 1))
        nav.addView(nextButton, LinearLayout.LayoutParams(0, WRAP, 2f))
        root.addView(nav, LinearLayout.LayoutParams(MATCH, WRAP))

        return root
    }

    private fun render() {
        val page = pages[step]
        emojiView.text = page.emoji
        titleView.text = page.title
        bodyView.text = page.body
        dotsView.text = pages.indices.joinToString("  ") { if (it == step) "●" else "○" }
        backButton.visibility = if (step == 0) View.INVISIBLE else View.VISIBLE
        // The example CTA is the star of the last page only.
        tryButton.visibility = if (step == pages.size - 1) View.VISIBLE else View.GONE
        nextButton.text = getString(
            if (step == pages.size - 1) R.string.onboarding_done else R.string.onboarding_next,
        )
    }

    private fun finishOnboarding(runExample: Boolean) {
        getSharedPreferences("tantular_guard", Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_ONBOARDING_DONE, true).apply()
        if (runExample) {
            startActivity(
                Intent(this, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    putExtra(MainActivity.EXTRA_RUN_EXAMPLE, true)
                },
            )
        }
        finish()
    }

    private fun pill(color: Int, radius: Float): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radius
            setColor(color)
        }

    companion object {
        const val KEY_ONBOARDING_DONE = "onboarding_done_v1"
        private const val MATCH = LinearLayout.LayoutParams.MATCH_PARENT
        private const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT
    }
}
