package ai.sakana.tantularguard

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Structured, scrollable view of the Guard Log. Each processed message is shown
 * as a card with a color-coded verdict badge, route, sender, time, risk score,
 * matched signals, and a message preview.
 */
class GuardLogActivity : Activity() {

    private lateinit var listContainer: LinearLayout
    private lateinit var emptyView: TextView
    private lateinit var countView: TextView

    private val timeFmt = SimpleDateFormat("dd MMM yyyy, HH:mm", Locale("in", "ID"))

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

        // Header
        column.addView(TextView(this).apply {
            text = getString(R.string.guard_log_dialog_title)
            setTextColor(Color.parseColor("#0B2545"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            setTypeface(typeface, Typeface.BOLD)
        })
        countView = TextView(this).apply {
            setTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(0, dp(4), 0, dp(12))
        }
        column.addView(countView)

        // Actions row
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                bottomMargin = dp(14)
            }
        }
        actions.addView(Button(this).apply {
            text = getString(R.string.guard_log_refresh)
            isAllCaps = false
            setOnClickListener { render() }
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(8) }
        })
        actions.addView(Button(this).apply {
            text = getString(R.string.clear_guard_log_button)
            isAllCaps = false
            setOnClickListener {
                GuardLog.clear(this@GuardLogActivity)
                render()
            }
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = dp(8) }
        })
        column.addView(actions)

        emptyView = TextView(this).apply {
            text = getString(R.string.guard_log_empty)
            setTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            visibility = View.GONE
        }
        column.addView(emptyView)

        listContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(listContainer)

        setContentView(root)
        render()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        val entries = GuardLog.list(this)
        listContainer.removeAllViews()
        countView.text = getString(R.string.guard_log_count_short, entries.size)
        emptyView.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
        for (e in entries) listContainer.addView(entryCard(e))
    }

    private fun entryCard(e: GuardLog.Entry): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(14).toFloat()
                setColor(Color.WHITE)
                setStroke(dp(1), Color.parseColor("#E2E8F0"))
            }
            setPadding(dp(14), dp(12), dp(14), dp(12))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                bottomMargin = dp(12)
            }
            isClickable = true
            setOnClickListener { openInChecker(e) }
        }

        val (badgeBg, badgeInk) = verdictColors(e.verdict)

        // Top row: verdict badge + channel + route + risk
        val topRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        topRow.addView(TextView(this).apply {
            text = verdictLabel(e.verdict)
            setTextColor(badgeInk)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(10), dp(3), dp(10), dp(3))
            background = GradientDrawable().apply {
                cornerRadius = dp(20).toFloat()
                setColor(badgeBg)
            }
        })
        topRow.addView(TextView(this).apply {
            text = "  ${e.channel} · ${routeLabel(e.route)}"
            setTextColor(Color.parseColor("#334155"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTypeface(typeface, Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        })
        topRow.addView(TextView(this).apply {
            text = "risk ${e.riskScore}"
            setTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        })
        card.addView(topRow)

        // Meta: sender + time
        card.addView(TextView(this).apply {
            text = "${e.source}  ·  ${timeFmt.format(Date(e.timestampMs))}"
            setTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, dp(8), 0, 0)
        })

        // Preview
        card.addView(TextView(this).apply {
            text = e.preview
            setTextColor(Color.parseColor("#0F172A"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setPadding(0, dp(6), 0, 0)
        })

        // Signals
        if (e.signals.isNotEmpty()) {
            card.addView(TextView(this).apply {
                text = getString(R.string.guard_log_signals_prefix, e.signals.joinToString(", "))
                setTextColor(badgeInk)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                setPadding(0, dp(8), 0, 0)
            })
        }

        // Tap hint
        card.addView(TextView(this).apply {
            text = getString(R.string.guard_log_tap_hint)
            setTextColor(Color.parseColor("#2563EB"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(8), 0, 0)
        })

        return card
    }

    /** Open this logged message in the main checker to re-run the on-device SLM. */
    private fun openInChecker(e: GuardLog.Entry) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_CHECK_TEXT, e.preview)
        }
        startActivity(intent)
    }

    private fun verdictColors(verdict: String): Pair<Int, Int> = when (verdict) {
        "BLOCK" -> Color.parseColor("#FEE2E2") to Color.parseColor("#B91C1C")
        "WARN" -> Color.parseColor("#FEF3C7") to Color.parseColor("#B45309")
        else -> Color.parseColor("#DCFCE7") to Color.parseColor("#15803D")
    }

    private fun verdictLabel(verdict: String): String = when (verdict) {
        "BLOCK" -> getString(R.string.verdict_block)
        "WARN" -> getString(R.string.verdict_warn)
        else -> getString(R.string.verdict_allow)
    }

    private fun routeLabel(route: String): String = when (route) {
        GuardLog.ROUTE_INBOX -> getString(R.string.route_inbox)
        GuardLog.ROUTE_INBOX_WARN -> getString(R.string.route_inbox_warn)
        GuardLog.ROUTE_WARNING -> getString(R.string.route_warning)
        GuardLog.ROUTE_QUARANTINE -> getString(R.string.route_quarantine)
        else -> route
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()
}
