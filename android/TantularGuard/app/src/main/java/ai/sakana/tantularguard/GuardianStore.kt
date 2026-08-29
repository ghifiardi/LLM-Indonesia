package ai.sakana.tantularguard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Local-only storage for Family Guardian settings. */
object GuardianStore {
    private const val PREFS = "tantular_guardian"
    private const val KEY_ON = "guardian_on"
    private const val KEY_NAME = "protected_name"
    private const val KEY_NUMBERS = "guardian_numbers"
    private const val KEY_LAST_ALERT = "last_alert_ms"        // legacy global (kept for the log line)
    private const val KEY_ALERT_HISTORY = "alert_history"     // {incidentKey: lastMs}
    private const val KEY_ALERT_TIMES = "alert_times"         // rolling timestamps for daily cap
    private const val HISTORY_TTL_MS = 24 * 60 * 60 * 1000L   // prune entries older than a day

    private fun p(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isEnabled(c: Context) = p(c).getBoolean(KEY_ON, false)
    fun setEnabled(c: Context, on: Boolean) = p(c).edit().putBoolean(KEY_ON, on).apply()

    fun protectedName(c: Context): String = p(c).getString(KEY_NAME, "") ?: ""
    fun setProtectedName(c: Context, name: String) = p(c).edit().putString(KEY_NAME, name.trim()).apply()

    fun numbers(c: Context): List<String> {
        val raw = p(c).getString(KEY_NUMBERS, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        return (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotBlank() } }
    }

    fun addNumber(c: Context, raw: String): Boolean {
        if (!GuardianAlert.isValidNumber(raw)) return false
        val n = GuardianAlert.normalizeNumber(raw)
        val cur = numbers(c).toMutableList()
        if (cur.contains(n)) return true
        cur.add(n)
        save(c, cur)
        return true
    }

    fun removeNumber(c: Context, number: String) {
        save(c, numbers(c).filter { it != number })
    }

    private fun save(c: Context, list: List<String>) {
        p(c).edit().putString(KEY_NUMBERS, JSONArray(list).toString()).apply()
    }

    /** Global last-alert time (any incident) — used only for the diagnostic log. */
    fun lastAlertMs(c: Context) = p(c).getLong(KEY_LAST_ALERT, 0L)

    /** Last time we alerted for THIS specific incident key (0 if never). */
    fun lastAlertForKey(c: Context, key: String): Long =
        history(c).optLong(key, 0L)

    /** Count guardian alerts sent in the rolling window ending at [nowMs]. */
    fun alertCountSince(c: Context, nowMs: Long, windowMs: Long = GuardianAlert.DAILY_WINDOW_MS): Int =
        recentAlertTimes(c, nowMs, windowMs).size

    /** Record a successful alert for an incident key + prune stale entries. */
    fun recordAlert(c: Context, key: String, ms: Long) {
        val h = history(c)
        h.put(key, ms)
        val cutoff = ms - HISTORY_TTL_MS
        val pruned = JSONObject()
        for (k in h.keys()) {
            val v = h.optLong(k, 0L)
            if (v >= cutoff) pruned.put(k, v)
        }
        val times = recentAlertTimes(c, ms, GuardianAlert.DAILY_WINDOW_MS).toMutableList().apply { add(ms) }
        p(c).edit()
            .putString(KEY_ALERT_HISTORY, pruned.toString())
            .putString(KEY_ALERT_TIMES, JSONArray(times).toString())
            .putLong(KEY_LAST_ALERT, ms)
            .apply()
    }

    private fun history(c: Context): JSONObject {
        val raw = p(c).getString(KEY_ALERT_HISTORY, "{}") ?: "{}"
        return runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
    }

    private fun recentAlertTimes(c: Context, nowMs: Long, windowMs: Long): List<Long> {
        val raw = p(c).getString(KEY_ALERT_TIMES, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        val cutoff = nowMs - windowMs
        return (0 until arr.length())
            .map { arr.optLong(it, 0L) }
            .filter { it >= cutoff && it <= nowMs }
    }
}
