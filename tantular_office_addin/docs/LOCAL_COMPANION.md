# Local Companion Runtime Notes

## Why a local companion app

A browser-only model can work, but a 300-800 MB quantized SLM loads separately per Office host webview. Word, Excel, and PowerPoint may each create their own webview context. That means duplicated memory, duplicated downloads, and slower startup.

A local companion app avoids this by running one model instance on `127.0.0.1`, shared by every add-in task pane. The Office add-in becomes a small UI/client; the companion owns model loading, model cache, and future enterprise policy controls.

## MVP development path

Use an OpenAI-compatible local endpoint:

- Ollama: `http://127.0.0.1:11434/v1/chat/completions`
- llama.cpp server: `http://127.0.0.1:8080/v1/chat/completions`

The task pane settings let you switch endpoint and model name.

## Production packaging goals

1. Bundle or download a signed GGUF model.
2. Store the model in an OS-appropriate application cache.
3. Expose a loopback API with strict CORS allowed origins for the Office add-in domain.
4. Provide a health endpoint for the task pane.
5. Cap context length, batch rows, and concurrent requests.
6. Log only metadata by default; never log raw document text unless the admin explicitly enables a secure diagnostic mode.
7. Support offline installs for government/school/SMB deployments.

## Suggested companion endpoints

```text
GET  /health
POST /v1/chat/completions
POST /tantular/classify-rows
POST /tantular/redact-pii
GET  /models
POST /models/select
```

The MVP add-in currently uses only `/v1/chat/completions` so it can run against Ollama immediately.

