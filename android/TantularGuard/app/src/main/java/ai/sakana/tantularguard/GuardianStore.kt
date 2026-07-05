package ai.sakana.tantularguard

import android.content.Context
import org.json.JSONArray

/** Local-only storage for Family Guardian settings. */
object GuardianStore {
    private const val PREFS = "tantular_guardian"
    private const val KEY_ON = "guardian_on"
    private const val KEY_NAME = "protected_name"
    private const val KEY_NUMBERS = "guardian_numbers"
    private const val KEY_LAST_ALERT = "last_alert_ms"

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

    fun lastAlertMs(c: Context) = p(c).getLong(KEY_LAST_ALERT, 0L)
    fun setLastAlertMs(c: Context, ms: Long) = p(c).edit().putLong(KEY_LAST_ALERT, ms).apply()
}
