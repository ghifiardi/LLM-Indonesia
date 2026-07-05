package ai.sakana.tantularguard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * On-device inbox of Family Guardian alerts RECEIVED on this (guardian) phone.
 *
 * Populated by SmsReceiver when Mode Pelindung is on and an incoming SMS carries
 * the Tantular alert signature — so alerts surface here even if the phone's
 * Messages app files the SMS into a spam folder. Local-only, like GuardLog.
 */
object GuardianInbox {

    data class Entry(
        val id: String,
        val timestampMs: Long,
        val sender: String,
        val body: String,
    )

    @Synchronized
    fun add(context: Context, sender: String, body: String, timestampMs: Long): Entry? {
        val text = body.trim()
        if (text.isEmpty()) return null
        val all = list(context).toMutableList()
        // Dedupe exact repeats (multipart re-delivery of the same alert).
        if (all.take(10).any { it.body == text && it.sender == sender }) return null
        val entry = Entry(
            id = "$timestampMs-${kotlin.math.abs((sender + text).hashCode())}",
            timestampMs = timestampMs,
            sender = sender.ifBlank { "?" },
            body = text.take(320),
        )
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
            out.add(
                Entry(
                    id = o.optString("id"),
                    timestampMs = o.optLong("timestampMs"),
                    sender = o.optString("sender"),
                    body = o.optString("body"),
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
                    .put("sender", e.sender)
                    .put("body", e.body),
            )
        }
        prefs(context).edit().putString(KEY_ITEMS, arr.toString()).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences("tantular_guardian_inbox", Context.MODE_PRIVATE)

    private const val KEY_ITEMS = "items"
    private const val MAX_ITEMS = 100
}
