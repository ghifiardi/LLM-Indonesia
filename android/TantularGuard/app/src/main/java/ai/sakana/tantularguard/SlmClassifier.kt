package ai.sakana.tantularguard

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
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
 * On-device llama.cpp runtime bridge (JNI into libtantular-llama.so).
 *
 * The native library is built only when the app is assembled with the
 * `-PtantularNative=true` Gradle flag AND the llama.cpp sources have been
 * fetched into `app/src/main/cpp/llama.cpp` (see `scripts/fetch_llama_cpp.sh`).
 * When the library is not bundled, [AVAILABLE] stays false and the guard falls
 * back to deterministic local rules — the app never crashes because of a
 * missing native layer.
 *
 * Threading: [classifyToken] is synchronized and holds a single loaded model
 * handle. It is designed to be called from a background thread (never the UI
 * thread), matching [OnDeviceSlmClassifier].
 */
object NativeLlama {

    @Volatile
    private var libLoaded: Boolean = false

    init {
        libLoaded = try {
            System.loadLibrary("tantular-llama")
            true
        } catch (t: Throwable) {
            // Library not bundled in this build variant; stay in fallback mode.
            false
        }
    }

    /** True once libtantular-llama.so is present and loaded in this build. */
    val AVAILABLE: Boolean
        get() = libLoaded

    // Cached, lazily loaded model handle (native pointer). 0 == not loaded.
    @Volatile
    private var modelHandle: Long = 0L

    @Volatile
    private var loadedModelPath: String? = null

    @Volatile
    private var loadedAdapterPath: String? = null

    /**
     * Run the constrained one-word classification locally and return the raw
     * model text (e.g. "PENIPUAN"). Returns null when the native layer is not
     * available, the model cannot be loaded, or inference fails — callers treat
     * null as "on-device SLM unavailable" and rely on the rule floor.
     */
    @Synchronized
    fun classifyToken(modelPath: String, adapterPath: String?, systemPrompt: String, message: String): String? {
        if (!libLoaded) return null

        if (modelHandle == 0L || loadedModelPath != modelPath || loadedAdapterPath != adapterPath) {
            if (modelHandle != 0L) {
                runCatching { nativeFreeModel(modelHandle) }
                modelHandle = 0L
                loadedModelPath = null
                loadedAdapterPath = null
            }
            modelHandle = runCatching { nativeLoadModel(modelPath, adapterPath.orEmpty(), DEFAULT_THREADS) }.getOrDefault(0L)
            loadedModelPath = if (modelHandle != 0L) modelPath else null
            loadedAdapterPath = if (modelHandle != 0L) adapterPath else null
        }
        if (modelHandle == 0L) return null

        return runCatching {
            nativeClassify(modelHandle, systemPrompt, message, MAX_NEW_TOKENS)
        }.getOrNull()
    }

    /** Optional: release the loaded model (e.g. on low memory). */
    @Synchronized
    fun release() {
        if (modelHandle != 0L) {
            runCatching { nativeFreeModel(modelHandle) }
            modelHandle = 0L
            loadedModelPath = null
            loadedAdapterPath = null
        }
    }

    // --- JNI surface (implemented in app/src/main/cpp/tantular_jni.cpp) ---
    private external fun nativeLoadModel(modelPath: String, adapterPath: String, threads: Int): Long
    private external fun nativeClassify(handle: Long, systemPrompt: String, message: String, maxTokens: Int): String?
    private external fun nativeFreeModel(handle: Long)

    private const val DEFAULT_THREADS = 4
    private const val MAX_NEW_TOKENS = 8
}

/**
 * On-device Tantular backend. Runs the quantized GGUF fully locally — no server,
 * no network, no IP. Degrades gracefully (never crashes) when the model file or
 * native runtime is not present yet, so the app stays shippable during rollout.
 *
 * Expected model path (adb-pushable, app-private external storage):
 *   /sdcard/Android/data/ai.sakana.tantularguard/files/models/tantular.gguf
 */
class OnDeviceSlmClassifier(private val modelFile: File, private val adapterFile: File? = null) : SlmClassifier {
    override val name = "On-device (llama.cpp)"

    fun modelPresent(): Boolean = modelFile.exists() && modelFile.length() > 0L
    fun adapterPresent(): Boolean = adapterFile?.let { it.exists() && it.length() > 0L } == true
    fun modelPath(): String = modelFile.absolutePath
    fun adapterPath(): String? = adapterFile?.absolutePath

    override fun classify(message: String): SlmResult {
        val start = System.currentTimeMillis()
        if (!modelPresent()) {
            return SlmResult(SlmLabel.UNKNOWN, "", 0L, name, false, "model on-device belum ada")
        }
        if (!NativeLlama.AVAILABLE) {
            return SlmResult(SlmLabel.UNKNOWN, "", 0L, name, false, "runtime on-device belum terpasang")
        }
        val raw = NativeLlama.classifyToken(modelFile.absolutePath, adapterFile?.takeIf { it.exists() && it.length() > 0L }?.absolutePath, SlmParsing.SYSTEM_PROMPT, message)
            ?: return SlmResult(SlmLabel.UNKNOWN, "", System.currentTimeMillis() - start, name, false, "inferensi gagal")
        return SlmResult(SlmParsing.parse(raw), raw.trim(), System.currentTimeMillis() - start, name, ok = true)
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
