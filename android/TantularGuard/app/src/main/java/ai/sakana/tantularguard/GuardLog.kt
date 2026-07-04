package ai.sakana.tantularguard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Lightweight, on-device log of every message Tantular Guard processed.
 *
 * The goal is visibility: the user can see that a "safe" SMS was allowed into
 * the inbox, that a suspicious one was warned, and that a dangerous one was
 * quarantined. Nothing is hidden. Stored locally via SharedPreferences + JSON;
 * production should move to Room/SQLCipher.
 */
object GuardLog {

    const val ROUTE_INBOX = "inbox"           // allowed into the SMS inbox
    const val ROUTE_INBOX_WARN = "inbox_warn" // delivered to inbox + warned
    const val ROUTE_WARNING = "warning"       // observed + warned (system delivered)
    const val ROUTE_QUARANTINE = "quarantine" // withheld from inbox

    data class Entry(
        val id: String,
        val timestampMs: Long,
        val channel: String,     // "SMS", "WhatsApp", ...
        val source: String,      // sender address / app label
        val preview: String,     // message text (trimmed)
        val verdict: String,     // ALLOW / WARN / BLOCK
        val route: String,
        val riskScore: Double,
        val signals: List<String>,
    )

    // add()/clear() do a read-modify-write on one SharedPreferences key. The SMS
    // receiver (main thread) and the notification service (background executor)
    // are independent concurrent writers, so serialize the whole compound op to
    // avoid lost entries.
    @Synchronized
    fun add(
        context: Context,
        channel: String,
        source: String,
        body: String,
        verdict: RiskScorer.GuardVerdict,
        route: String,
    ): Entry {
        val entry = Entry(
            id = "${System.currentTimeMillis()}-${kotlin.math.abs(body.hashCode())}",
            timestampMs = System.currentTimeMillis(),
            channel = channel,
            source = source.ifBlank { "?" },
            preview = body.trim().take(240),
            verdict = verdict.verdict.name,
            route = route,
            riskScore = verdict.riskScore,
            signals = verdict.matchedSignals,
        )
        val all = list(context).toMutableList()
        all.add(0, entry)
        save(context, all.take(MAX_ITEMS))
        return entry
    }

    fun list(context: Context): List<Entry> {
        val raw = prefs(context).getString(KEY_ITEMS, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        val out = mutableListOf<Entry>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val sigArr = o.optJSONArray("signals") ?: JSONArray()
            val signals = (0 until sigArr.length()).mapNotNull { sigArr.optString(it).takeIf { s -> s.isNotBlank() } }
            out.add(
                Entry(
                    id = o.optString("id"),
                    timestampMs = o.optLong("timestampMs"),
                    channel = o.optString("channel"),
                    source = o.optString("source"),
                    preview = o.optString("preview"),
                    verdict = o.optString("verdict"),
                    route = o.optString("route"),
                    riskScore = o.optDouble("riskScore"),
                    signals = signals,
                ),
            )
        }
        return out
    }

    fun count(context: Context): Int = list(context).size

    @Synchronized
    fun clear(context: Context) {
        prefs(context).edit().putString(KEY_ITEMS, "[]").apply()
    }

    private fun save(context: Context, items: List<Entry>) {
        val arr = JSONArray()
        for (e in items) {
            arr.put(
                JSONObject()
                    .put("id", e.id)
                    .put("timestampMs", e.timestampMs)
                    .put("channel", e.channel)
                    .put("source", e.source)
                    .put("preview", e.preview)
                    .put("verdict", e.verdict)
                    .put("route", e.route)
                    .put("riskScore", e.riskScore)
                    .put("signals", JSONArray(e.signals)),
            )
        }
        prefs(context).edit().putString(KEY_ITEMS, arr.toString()).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences("tantular_guard_log", Context.MODE_PRIVATE)

    private const val KEY_ITEMS = "items"
    private const val MAX_ITEMS = 100
}
