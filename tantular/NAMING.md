# Tantular — model naming & tag scheme

**Tantular** is named after Mpu Tantular, the 14th-century Majapahit poet whose
*Kakawin Sutasoma* gave Indonesia its motto **Bhinneka Tunggal Ika** ("Unity in
Diversity"). The name frames the model's mission: one voice for a linguistically
diverse Nusantara.

## Tag scheme

Use a consistent Ollama tag scheme so bake-offs and lineage stay clean:

| Tag | What it is | Modelfile |
|-----|------------|-----------|
| `tantular:0.1-base`      | imported base GGUF, no fine-tune       | `Modelfile.base` |
| `tantular:0.1-id`        | + Indonesian system prompt (SYSTEM)    | `Modelfile.id` |
| `tantular:0.1-id-lora`   | + your LoRA adapter                     | `Modelfile.id-lora` |
| `tantular:0.1-id-safety` | safety-hardened variant                 | `Modelfile.id-safety` |

Keep `tantular:latest` pointing at the current best model+recipe you've
validated on the **holdout** split.

Convention: `tantular:<version>-<lang>[-<variant>]`
- `<version>` — weights/recipe generation (`0.1`, `0.2`, …). Bump when the base
  weights or the LoRA changes.
- `<lang>` — target locale (`id`). Reserve room for regional tags later
  (`id-jv`, `id-su`).
- `<variant>` — optional behaviour tag (`lora`, `safety`).

## Build all variants

```bash
cd godel_agent_prototype
ollama create tantular:0.1-base       -f tantular/Modelfile.base
ollama create tantular:0.1-id         -f tantular/Modelfile.id
ollama create tantular:0.1-id-safety  -f tantular/Modelfile.id-safety
# needs tantular/adapters/tantular-id-lora present:
ollama create tantular:0.1-id-lora    -f tantular/Modelfile.id-lora
```

## Bake-off (rank the variants on the eval set)

The Python leaderboard scores each tag with the same rubric/holdout split used
everywhere else in the prototype:

```bash
# dry-run (no Ollama needed) — validates the harness
python3 -m godel_agent_prototype.benchmark_ollama_models --dry-run \
    --models tantular:0.1-id tantular:0.1-id-safety

# real bake-off on the private holdout split
python3 -m godel_agent_prototype.benchmark_ollama_models --split holdout \
    --models tantular:0.1-id tantular:0.1-id-lora tantular:0.1-id-safety \
    --out reports/tantular_bakeoff.json
```

Promote the winner to `tantular:latest`:

```bash
ollama cp tantular:0.1-id-safety tantular:latest
```

## Notes

- SYSTEM prompts in the Modelfiles are kept in sync with `DEFAULT_RECIPE` in
  `benchmark_ollama_indonesian.py`, so the Ollama tag and the Python benchmark
  score the same behaviour.
- Adapters live under `tantular/adapters/` and are git-ignored — train them
  against the exact `tantular:0.1-base` weights or Ollama will refuse to load.
