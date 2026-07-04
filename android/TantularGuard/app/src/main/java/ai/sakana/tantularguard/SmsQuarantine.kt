package ai.sakana.tantularguard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Tiny local quarantine store for Stage 2B.
 *
 * This deliberately uses SharedPreferences + JSON to keep the prototype small.
 * Production should use Room/SQLCipher and richer message metadata.
 */
object SmsQuarantine {
    const val EXTRA_QUARANTINE_ID = "ai.sakana.tantularguard.extra.QUARANTINE_ID"

    data class Item(
        val id: String,
        val timestampMs: Long,
        val address: String,
        val body: String,
        val verdict: String,
        val riskScore: Double,
        val signals: List<String>,
    )

    // Serialize the read-modify-write so concurrent writers (SMS receiver on the
    // main thread, notification service on its executor) cannot clobber entries.
    @Synchronized
    fun add(context: Context, address: String, body: String, verdict: RiskScorer.GuardVerdict): Item {
        val item = Item(
            id = "${System.currentTimeMillis()}-${kotlin.math.abs(body.hashCode())}",
            timestampMs = System.currentTimeMillis(),
            address = address,
            body = body,
            verdict = verdict.verdict.name,
            riskScore = verdict.riskScore,
            signals = verdict.matchedSignals,
        )
        val all = list(context).toMutableList()
        all.add(0, item)
        save(context, all.take(MAX_ITEMS))
        return item
    }

    fun list(context: Context): List<Item> {
        val raw = prefs(context).getString(KEY_ITEMS, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        val out = mutableListOf<Item>()
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val signalsArr = obj.optJSONArray("signals") ?: JSONArray()
            val signals = (0 until signalsArr.length()).mapNotNull { signalsArr.optString(it).takeIf { s -> s.isNotBlank() } }
            out.add(
                Item(
                    id = obj.optString("id"),
                    timestampMs = obj.optLong("timestampMs"),
                    address = obj.optString("address"),
                    body = obj.optString("body"),
                    verdict = obj.optString("verdict"),
                    riskScore = obj.optDouble("riskScore"),
                    signals = signals,
                )
            )
        }
        return out
    }

    fun find(context: Context, id: String): Item? = list(context).firstOrNull { it.id == id }

    fun count(context: Context): Int = list(context).size

    fun latest(context: Context): Item? = list(context).firstOrNull()

    @Synchronized
    fun clear(context: Context) {
        prefs(context).edit().putString(KEY_ITEMS, "[]").apply()
    }

    private fun save(context: Context, items: List<Item>) {
        val arr = JSONArray()
        for (item in items) {
            arr.put(
                JSONObject()
                    .put("id", item.id)
                    .put("timestampMs", item.timestampMs)
                    .put("address", item.address)
                    .put("body", item.body)
                    .put("verdict", item.verdict)
                    .put("riskScore", item.riskScore)
                    .put("signals", JSONArray(item.signals)),
            )
        }
        prefs(context).edit().putString(KEY_ITEMS, arr.toString()).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences("tantular_quarantine", Context.MODE_PRIVATE)

    private const val KEY_ITEMS = "items"
    private const val MAX_ITEMS = 50
}
