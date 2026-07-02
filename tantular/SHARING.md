# Sharing Tantular with a colleague

The model lives only in the author's local Ollama. To let a colleague test it,
have them **rebuild it from the Modelfile** — the 7B variant is just the public
`qwen2.5:7b` base plus Tantular's SYSTEM prompt, so there are no large custom
weights to transfer.

## Rebuild the 7B assistant (`tantular:latest`)

Your colleague needs Ollama installed (https://ollama.com/download) and the file
`tantular/Modelfile.id-7b` from this repo (branch `feat/tantular-model-naming`).

```bash
# 1. get the base (public, ~4.7 GB)
ollama pull qwen2.5:7b

# 2. build the identical Tantular model from the Modelfile
ollama create tantular -f Modelfile.id-7b

# 3. run it
ollama run tantular
```

That reproduces `tantular:latest` exactly (same base + same persona). ~2 minutes
after the base finishes downloading.

Only have the Modelfile, not the repo? It is self-contained — copy
`tantular/Modelfile.id-7b` into any folder and run the commands from there.

## Optional: the fast 1.5B specialist (`tantular:0.1-id-lora`)

This one DOES include trained weights (a LoRA adapter), so the colleague also
needs the adapter file:

```bash
# author sends two files:
#   tantular/Modelfile.id-lora
#   tantular/adapters/tantular-id-lora.gguf   (~17 MB, git-ignored)
# colleague, with both files laid out as tantular/adapters/tantular-id-lora.gguf:
ollama pull qwen2.5:1.5b
ollama create tantular-lora -f Modelfile.id-lora
ollama run tantular-lora
```

## Alternatives (not needed for Option A)

- **Publish to the Ollama registry** so anyone can `ollama pull you/tantular`
  — but registry models are PUBLIC, so this shares the model (and SYSTEM prompt)
  with the world.
- **Expose your local server on a trusted LAN**:
  `launchctl setenv OLLAMA_HOST 0.0.0.0:11434` on your machine, then the
  colleague runs `OLLAMA_HOST=http://<your-ip>:11434 ollama run tantular`.
  Unset it afterwards; do not expose Ollama on untrusted networks.

See also: [NAMING.md](NAMING.md) · [FINETUNE.md](FINETUNE.md) · [POSITIONING.md](POSITIONING.md)
