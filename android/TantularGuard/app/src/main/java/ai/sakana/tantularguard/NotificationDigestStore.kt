package ai.sakana.tantularguard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

/**
 * On-device store for the Personal Notification Digest (Cluster D).
 *
 * Mirrors GuardLog: SharedPreferences + JSON, capped, writes serialized. Kept
 * separate from GuardLog so "Ringkasan Hari Ini" (what matters today) and
 * "Riwayat Pemeriksaan" (what the scam guard processed) never clobber each other.
 * Nothing leaves the device.
 */
object NotificationDigestStore {

    data class Entry(
        val id: String,
        val timestampMs: Long,
        val packageName: String,
        val app: String,        // human app label (PackageManager)
        val category: String,   // keuangan | paket | ...
        val priority: String,   // tinggi | sedang | rendah
        val title: String,
        val preview: String,    // trimmed notification text
    )

    /**
     * Store a classified notification. Dedupes: if the most recent entries
     * already contain the same package + preview, nothing is added. Returns the
     * stored Entry, or null when empty/deduped.
     */
    @Synchronized
    fun add(
        context: Context,
        packageName: String,
        app: String,
        category: String,
        priority: String,
        title: String,
        text: String,
    ): Entry? {
        val preview = text.trim().take(240)
        if (preview.isEmpty()) return null
        val all = list(context).toMutableList()
        if (all.take(DEDUPE_WINDOW).any { it.packageName == packageName && it.preview == preview }) {
            return null
        }
        val entry = Entry(
            id = "${System.currentTimeMillis()}-${kotlin.math.abs((packageName + preview).hashCode())}",
            timestampMs = System.currentTimeMillis(),
            packageName = packageName,
            app = app.ifBlank { packageName },
            category = category,
            priority = priority,
            title = title.trim().take(120),
            preview = preview,
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
                    packageName = o.optString("packageName"),
                    app = o.optString("app"),
                    category = o.optString("category"),
                    priority = o.optString("priority"),
                    title = o.optString("title"),
                    preview = o.optString("preview"),
                ),
            )
        }
        return out
    }

    /** Entries since local midnight, newest-first. */
    fun today(context: Context): List<Entry> {
        val start = startOfTodayMs()
        return list(context).filter { it.timestampMs >= start }
    }

    fun countToday(context: Context): Int = today(context).size

    /**
     * Today's entries grouped by category in the classifier's display order.
     * Only non-empty categories are returned. When [importantOnly] is true,
     * promo + umum are excluded.
     */
    fun groupedToday(context: Context, importantOnly: Boolean): List<Pair<String, List<Entry>>> {
        // Re-classify on read using the latest classifier. This fixes older
        // digest entries after rule tuning (for example: "coding" used to
        // contain the naive "cod" package signal and appeared under Paket).
        val today = today(context).map { e ->
            val cat = NotificationClassifier.classify(e.preview, e.title)
            e.copy(category = cat.key, priority = cat.priority)
        }.filter {
            NotificationClassifier.shouldKeepForDigest(it.packageName, it.title, it.category)
        }
        val byCat = today.groupBy { it.category }
        return NotificationClassifier.ORDER.mapNotNull { cat ->
            if (importantOnly && cat in NotificationClassifier.UNIMPORTANT) return@mapNotNull null
            val items = byCat[cat] ?: return@mapNotNull null
            if (items.isEmpty()) null else cat to items.sortedByDescending { it.timestampMs }
        }
    }

    fun count(context: Context): Int = list(context).size

    @Synchronized
    fun clear(context: Context) {
        prefs(context).edit().putString(KEY_ITEMS, "[]").apply()
    }

    private fun startOfTodayMs(): Long {
        val c = Calendar.getInstance()
        c.set(Calendar.HOUR_OF_DAY, 0)
        c.set(Calendar.MINUTE, 0)
        c.set(Calendar.SECOND, 0)
        c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }

    private fun save(context: Context, items: List<Entry>) {
        val arr = JSONArray()
        for (e in items) {
            arr.put(
                JSONObject()
                    .put("id", e.id)
                    .put("timestampMs", e.timestampMs)
                    .put("packageName", e.packageName)
                    .put("app", e.app)
                    .put("category", e.category)
                    .put("priority", e.priority)
                    .put("title", e.title)
                    .put("preview", e.preview),
            )
        }
        prefs(context).edit().putString(KEY_ITEMS, arr.toString()).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences("tantular_digest_log", Context.MODE_PRIVATE)

    private const val KEY_ITEMS = "items"
    private const val MAX_ITEMS = 200
    private const val DEDUPE_WINDOW = 30
}
