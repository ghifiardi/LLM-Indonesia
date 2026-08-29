#include <jni.h>
#include <android/log.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "llama.h"

// -----------------------------------------------------------------------------
// Tantular on-device classifier (JNI -> llama.cpp).
//
// API COMPATIBILITY NOTE
// This file targets a recent llama.cpp master (vocab-based tokenizer API +
// llama_sampler chain). scripts/fetch_llama_cpp.sh pins a commit. If you pin an
// OLDER llama.cpp, a few symbols were renamed and must be adjusted:
//   llama_model_load_from_file   <- older: llama_load_model_from_file
//   llama_init_from_model        <- older: llama_new_context_with_model
//   llama_model_free             <- older: llama_free_model
//   llama_model_get_vocab / vocab-based llama_tokenize / llama_token_to_piece /
//   llama_vocab_is_eog           <- older: model-based equivalents
// -----------------------------------------------------------------------------

#define TANTULAR_LOG_TAG "TantularNative"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TANTULAR_LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TANTULAR_LOG_TAG, __VA_ARGS__)

namespace {

struct TantularHandle {
    llama_model* model = nullptr;
    llama_adapter_lora* adapter = nullptr;
    const llama_vocab* vocab = nullptr;
    int threads = 4;
};

std::once_flag g_backend_once;

std::string jstring_to_string(JNIEnv* env, jstring value) {
    if (value == nullptr) return {};
    const char* chars = env->GetStringUTFChars(value, nullptr);
    if (chars == nullptr) return {};
    std::string out(chars);
    env->ReleaseStringUTFChars(value, chars);
    return out;
}

std::string trim(const std::string& input) {
    auto begin = std::find_if_not(input.begin(), input.end(),
                                  [](unsigned char c) { return std::isspace(c); });
    auto end = std::find_if_not(input.rbegin(), input.rend(),
                                [](unsigned char c) { return std::isspace(c); }).base();
    if (begin >= end) return {};
    return std::string(begin, end);
}

std::string upper_ascii(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return s;
}

bool contains_label(const std::string& raw) {
    const auto u = upper_ascii(raw);
    return u.find("PENIPUAN") != std::string::npos ||
           u.find("MENCURIGA") != std::string::npos ||
           u.find("AMAN") != std::string::npos;
}

std::string build_prompt(const std::string& system_prompt, const std::string& message) {
    // Chat-template independent prompt. The system instruction is strict and the
    // Kotlin SlmParsing layer parses the reply tolerantly.
    return system_prompt + "\n\nPesan:\n" + message + "\n\nJawaban (satu kata):";
}

std::vector<llama_token> tokenize(const llama_vocab* vocab, const std::string& text, bool add_special) {
    int n = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()),
                           nullptr, 0, add_special, true);
    if (n >= 0) return {}; // expected negative == required capacity
    std::vector<llama_token> tokens(static_cast<size_t>(-n));
    int written = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()),
                                 tokens.data(), static_cast<int32_t>(tokens.size()),
                                 add_special, true);
    if (written < 0) return {};
    tokens.resize(static_cast<size_t>(written));
    return tokens;
}

std::string piece_for(const llama_vocab* vocab, llama_token token) {
    char buf[256];
    int n = llama_token_to_piece(vocab, token, buf, sizeof(buf), 0, true);
    if (n <= 0) return {};
    return std::string(buf, buf + n);
}

} // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_ai_sakana_tantularguard_NativeLlama_nativeLoadModel(
    JNIEnv* env, jobject, jstring model_path, jstring adapter_path, jint threads) {

    std::call_once(g_backend_once, []() {
        llama_backend_init();
        LOGI("llama backend initialized");
    });

    const std::string path = jstring_to_string(env, model_path);
    const std::string lora_path = jstring_to_string(env, adapter_path);
    if (path.empty()) {
        LOGE("empty model path");
        return 0;
    }

    llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = 0; // CPU-only for predictable Android behavior.

    llama_model* model = llama_model_load_from_file(path.c_str(), model_params);
    if (model == nullptr) {
        LOGE("failed to load model: %s", path.c_str());
        return 0;
    }

    const llama_vocab* vocab = llama_model_get_vocab(model);
    if (vocab == nullptr) {
        LOGE("failed to get vocab");
        llama_model_free(model);
        return 0;
    }

    llama_adapter_lora* adapter = nullptr;
    if (!lora_path.empty()) {
        adapter = llama_adapter_lora_init(model, lora_path.c_str());
        if (adapter == nullptr) {
            LOGE("failed to load lora adapter: %s", lora_path.c_str());
            llama_model_free(model);
            return 0;
        }
        LOGI("lora adapter loaded: %s", lora_path.c_str());
    }

    auto* handle = new TantularHandle();
    handle->model = model;
    handle->adapter = adapter;
    handle->vocab = vocab;
    handle->threads = std::max(1, static_cast<int>(threads));
    LOGI("model loaded: %s", path.c_str());
    return reinterpret_cast<jlong>(handle);
}

extern "C" JNIEXPORT jstring JNICALL
Java_ai_sakana_tantularguard_NativeLlama_nativeClassify(
    JNIEnv* env, jobject, jlong handle_ptr,
    jstring system_prompt_j, jstring message_j, jint max_tokens) {

    auto* handle = reinterpret_cast<TantularHandle*>(handle_ptr);
    if (handle == nullptr || handle->model == nullptr || handle->vocab == nullptr) {
        return nullptr;
    }

    const std::string system_prompt = jstring_to_string(env, system_prompt_j);
    const std::string message = jstring_to_string(env, message_j);
    const std::string prompt = build_prompt(system_prompt, message);

    std::vector<llama_token> tokens = tokenize(handle->vocab, prompt, true);
    if (tokens.empty()) {
        LOGE("tokenize produced no tokens");
        return nullptr;
    }

    // Fresh context per call: avoids KV-cache-clear API churn and keeps memory
    // bounded between classifications.
    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = 768;
    ctx_params.n_batch = 256;
    ctx_params.n_threads = handle->threads;
    ctx_params.n_threads_batch = handle->threads;

    llama_context* ctx = llama_init_from_model(handle->model, ctx_params);
    if (ctx == nullptr) {
        LOGE("failed to create context");
        return nullptr;
    }

    if (handle->adapter != nullptr) {
        llama_adapter_lora* adapters[] = { handle->adapter };
        float scales[] = { 1.0f };
        if (llama_set_adapters_lora(ctx, adapters, 1, scales) != 0) {
            LOGE("failed to attach lora adapter to context");
            llama_free(ctx);
            return nullptr;
        }
    }

    llama_sampler* sampler = llama_sampler_init_greedy();
    std::string output;
    bool ok = true;

    llama_batch batch = llama_batch_get_one(tokens.data(), static_cast<int32_t>(tokens.size()));
    if (llama_decode(ctx, batch) != 0) {
        LOGE("prompt decode failed");
        ok = false;
    }

    const int limit = std::max(1, static_cast<int>(max_tokens));
    for (int i = 0; ok && i < limit; ++i) {
        llama_token next = llama_sampler_sample(sampler, ctx, -1);
        if (llama_vocab_is_eog(handle->vocab, next)) break;

        output += piece_for(handle->vocab, next);
        if (contains_label(output)) break;

        llama_batch step = llama_batch_get_one(&next, 1);
        if (llama_decode(ctx, step) != 0) {
            LOGE("token decode failed");
            break;
        }
    }

    llama_sampler_free(sampler);
    llama_free(ctx);

    output = trim(output);
    if (!ok || output.empty()) return nullptr;
    return env->NewStringUTF(output.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_ai_sakana_tantularguard_NativeLlama_nativeFreeModel(
    JNIEnv*, jobject, jlong handle_ptr) {

    auto* handle = reinterpret_cast<TantularHandle*>(handle_ptr);
    if (handle == nullptr) return;
    if (handle->adapter != nullptr) llama_adapter_lora_free(handle->adapter);
    if (handle->model != nullptr) llama_model_free(handle->model);
    delete handle;
}
