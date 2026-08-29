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
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * "Ringkasan Hari Ini" — today's useful notifications grouped by everyday
 * category. On-demand, on-device, mirrors GuardLogActivity's programmatic style.
 */
class NotificationDigestActivity : Activity() {

    private lateinit var listContainer: LinearLayout
    private lateinit var emptyView: TextView
    private lateinit var countView: TextView

    private val timeFmt = SimpleDateFormat("HH:mm", Locale("in", "ID"))
    private val ITEMS_PER_GROUP = 3

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

        column.addView(TextView(this).apply {
            text = getString(R.string.digest_screen_title)
            setTextColor(Color.parseColor("#0B2545"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            setTypeface(typeface, Typeface.BOLD)
        })
        countView = TextView(this).apply {
            setTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(0, dp(4), 0, dp(4))
        }
        column.addView(countView)

        column.addView(TextView(this).apply {
            text = getString(R.string.digest_privacy)
            setTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, 0, 0, dp(10))
        })

        // Important-only toggle
        val importantToggle = Switch(this).apply {
            text = getString(R.string.digest_important_only)
            isChecked = prefs().getBoolean(MainActivity.KEY_DIGEST_IMPORTANT_ONLY, false)
            setOnCheckedChangeListener { _, checked ->
                prefs().edit().putBoolean(MainActivity.KEY_DIGEST_IMPORTANT_ONLY, checked).apply()
                render()
            }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                bottomMargin = dp(10)
            }
        }
        column.addView(importantToggle)

        // Actions
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                bottomMargin = dp(14)
            }
        }
        actions.addView(Button(this).apply {
            text = getString(R.string.digest_refresh)
            isAllCaps = false
            setOnClickListener { render() }
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(8) }
        })
        actions.addView(Button(this).apply {
            text = getString(R.string.digest_clear)
            isAllCaps = false
            setOnClickListener {
                NotificationDigestStore.clear(this@NotificationDigestActivity)
                render()
                Toast.makeText(this@NotificationDigestActivity, R.string.digest_cleared, Toast.LENGTH_SHORT).show()
            }
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = dp(8) }
        })
        column.addView(actions)

        emptyView = TextView(this).apply {
            text = getString(R.string.digest_empty)
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
        val importantOnly = prefs().getBoolean(MainActivity.KEY_DIGEST_IMPORTANT_ONLY, false)
        val groups = NotificationDigestStore.groupedToday(this, importantOnly)
        val total = groups.sumOf { it.second.size }
        listContainer.removeAllViews()
        countView.text = getString(R.string.digest_count_today, total)
        emptyView.visibility = if (groups.isEmpty()) View.VISIBLE else View.GONE
        for ((cat, items) in groups) listContainer.addView(groupCard(cat, items))
    }

    private fun groupCard(category: String, items: List<NotificationDigestStore.Entry>): View {
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
        }

        // Heading: "💰 Keuangan (3)"
        card.addView(TextView(this).apply {
            text = "${NotificationClassifier.emoji(category)} ${NotificationClassifier.label(category)} (${items.size})"
            setTextColor(Color.parseColor("#0B2545"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, 0, 0, dp(6))
        })

        for (e in items.take(ITEMS_PER_GROUP)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(6), 0, dp(6))
                isClickable = true
                setOnClickListener { openInChecker(e) }
            }
            row.addView(TextView(this).apply {
                val head = if (e.title.isNotBlank() && !e.app.equals(e.title, true)) "${e.app} · ${e.title}" else e.app
                text = "$head  ·  ${timeFmt.format(Date(e.timestampMs))}"
                setTextColor(Color.parseColor("#334155"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                setTypeface(typeface, Typeface.BOLD)
            })
            row.addView(TextView(this).apply {
                text = e.preview
                setTextColor(Color.parseColor("#0F172A"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                maxLines = 2
                setPadding(0, dp(2), 0, 0)
            })
            card.addView(row)
        }

        val extra = items.size - ITEMS_PER_GROUP
        if (extra > 0) {
            card.addView(TextView(this).apply {
                text = getString(R.string.digest_more_items, extra)
                setTextColor(Color.parseColor("#2563EB"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                setTypeface(typeface, Typeface.BOLD)
                setPadding(0, dp(6), 0, 0)
            })
        }

        return card
    }

    /** Re-run a digest item through the main checker (useful for suspicious ones). */
    private fun openInChecker(e: NotificationDigestStore.Entry) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_CHECK_TEXT, e.preview)
        }
        startActivity(intent)
    }

    private fun prefs() = getSharedPreferences("tantular_guard", Context.MODE_PRIVATE)

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
