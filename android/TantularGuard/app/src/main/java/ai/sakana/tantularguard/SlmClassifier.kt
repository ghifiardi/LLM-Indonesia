package ai.sakana.tantularguard

import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * The SLM (Tantular) contextual reasoning layer for Tantular Guard.
 *
 * Design invariant: the SLM is advisory. It can ESCALATE a borderline message
 * (mencurigakan -> warn, penipuan -> block) but never downgrades a verdict the
 * deterministic [RiskScorer] floor already reached. Hard fraud gates stay in the
 * rules, so protection is predictable even when the model is wrong or offline.
 */
enum class SlmLabel { PENIPUAN, MENCURIGAKAN, AMAN, UNKNOWN }

data class SlmResult(
    val label: SlmLabel,
    val raw: String,
    val latencyMs: Long,
    val backend: String,
    val ok: Boolean,
    val error: String? = null,
)

interface SlmClassifier {
    val name: String
    fun classify(message: String): SlmResult
}

/** Shared prompt + tolerant single-word parser (small models are noisy). */
object SlmParsing {
    const val SYSTEM_PROMPT =
        "Anda pengklasifikasi keamanan pesan. Balas HANYA satu kata tanpa tanda baca: " +
            "PENIPUAN, MENCURIGAKAN, atau AMAN. PENIPUAN jika pesan meminta OTP, PIN, CVV, " +
            "password, minta klik link atau instal APK, atau minta remote access. AMAN jika " +
            "pesan biasa tanpa permintaan data sensitif. Jika ragu, jawab MENCURIGAKAN."

    fun parse(raw: String): SlmLabel {
        val u = raw.uppercase().trim()
        return when {
            u.contains("PENIPUAN") -> SlmLabel.PENIPUAN
            u.contains("MENCURIGA") -> SlmLabel.MENCURIGAKAN
            // Tolerate small-model typos like "AMAKAN" for "AMAN".
            u.contains("AMAN") || u.startsWith("AMA") -> SlmLabel.AMAN
            else -> SlmLabel.UNKNOWN
        }
    }
}

/**
 * Offline default backend: a deterministic label derived from the rule signals.
 * Keeps Stage 1 fully local and testable when no SLM server is configured.
 */
class StubSlmClassifier : SlmClassifier {
    override val name = "stub-lokal"

    override fun classify(message: String): SlmResult {
        val (_, matched) = RiskScorer.score(message)
        val label = when {
            matched.any { it in RiskScorer.HIGH_RISK } -> SlmLabel.PENIPUAN
            matched.isNotEmpty() -> SlmLabel.MENCURIGAKAN
            else -> SlmLabel.AMAN
        }
        return SlmResult(label, label.name, 0L, name, ok = true)
    }
}

/**
 * Real Tantular backend over Ollama's /api/chat. Opt-in (needs a reachable
 * server + INTERNET). Blocking network call — invoke off the UI thread.
 */
class OllamaSlmClassifier(
    baseUrl: String,
    private val model: String,
    private val timeoutMs: Int = 12000,
) : SlmClassifier {

    private val endpoint = normalize(baseUrl)
    override val name = "Tantular SLM ($model)"

    override fun classify(message: String): SlmResult {
        val start = clock()
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$endpoint/api/chat").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Content-Type", "application/json")
            }
            val payload = JSONObject()
                .put("model", model)
                .put("stream", false)
                .put("options", JSONObject().put("temperature", 0).put("num_predict", 8))
                .put(
                    "messages",
                    JSONArray()
                        .put(JSONObject().put("role", "system").put("content", SlmParsing.SYSTEM_PROMPT))
                        .put(JSONObject().put("role", "user").put("content", message)),
                )
                .toString()
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(payload) }

            val code = conn.responseCode
            if (code !in 200..299) {
                return SlmResult(SlmLabel.UNKNOWN, "", clock() - start, name, false, "HTTP $code")
            }
            val body = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val content = JSONObject(body).getJSONObject("message").getString("content")
            SlmResult(SlmParsing.parse(content), content.trim(), clock() - start, name, ok = true)
        } catch (e: Exception) {
            SlmResult(SlmLabel.UNKNOWN, "", clock() - start, name, false, e.message ?: e.javaClass.simpleName)
        } finally {
            conn?.disconnect()
        }
    }

    private fun clock() = System.currentTimeMillis()

    private fun normalize(url: String): String {
        var s = url.trim().trimEnd('/')
        if (s.endsWith("/v1")) s = s.dropLast(3)
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        return s
    }
}
