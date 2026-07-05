package ai.sakana.tantularguard

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * "Kotak Pelindung" — Family Guardian alerts received on this phone, surfaced
 * in-app so they can't be lost to the Messages app's spam folder.
 */
class GuardianInboxActivity : Activity() {

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

        column.addView(TextView(this).apply {
            text = getString(R.string.guardian_inbox_title)
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

        column.addView(Button(this).apply {
            text = getString(R.string.guardian_inbox_clear)
            isAllCaps = false
            setOnClickListener {
                GuardianInbox.clear(this@GuardianInboxActivity)
                render()
                Toast.makeText(this@GuardianInboxActivity, R.string.guardian_inbox_cleared, Toast.LENGTH_SHORT).show()
            }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(14) }
        })

        emptyView = TextView(this).apply {
            text = getString(R.string.guardian_inbox_empty)
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
        val entries = GuardianInbox.list(this)
        listContainer.removeAllViews()
        countView.text = getString(R.string.guardian_inbox_count, entries.size)
        emptyView.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
        for (e in entries) listContainer.addView(card(e))
    }

    private fun card(e: GuardianInbox.Entry): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(14).toFloat()
                setColor(Color.WHITE)
                setStroke(dp(1), Color.parseColor("#E2E8F0"))
            }
            setPadding(dp(14), dp(12), dp(14), dp(12))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(12) }
        }
        card.addView(TextView(this).apply {
            text = "🛡️ ${e.sender}  ·  ${timeFmt.format(Date(e.timestampMs))}"
            setTextColor(Color.parseColor("#334155"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTypeface(typeface, Typeface.BOLD)
        })
        card.addView(TextView(this).apply {
            text = e.body
            setTextColor(Color.parseColor("#0F172A"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setPadding(0, dp(6), 0, 0)
        })
        return card
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
