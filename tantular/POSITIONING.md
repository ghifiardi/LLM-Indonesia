# Tantular — Positioning

**Tantular** is named after Mpu Tantular, the 14th-century Majapahit poet whose
*Kakawin Sutasoma* gave Indonesia its motto **Bhinneka Tunggal Ika** ("Unity in
Diversity"). The name anchors the product story: one voice for a linguistically
diverse Nusantara.

## One-line positioning

> **Tantular is the specialist, on-device Indonesian *safety-and-service* SLM —
> small enough to run locally and cheaply, transparent enough to audit, tuned to
> beat the giants on the narrow tasks that actually ship.**

The incumbents are **generalist foundation models**. Tantular is a **task-tuned
edge model**. Different category — and that is the point.

## The landscape

| Model | Owner | Name origin | Category | Size |
|---|---|---|---|---|
| Sahabat-AI | Indosat + GoTo | "sahabat" = friend | Consumer generalist (telco scale) | 8–9B |
| Komodo-7B | Yellow.ai | Komodo dragon | Regional-language generalist | 7B |
| SEA-LION | AI Singapore | SE-Asian languages | Regional multi-SEA generalist | 8–70B |
| Merah Putih LLM | Gov consortium | the flag | Sovereign / state generalist | large |
| SABDA AI | SABDA ministry | "sabda" = sacred word ⚠️ | Religious/ministry (hosted service) | — |
| **Tantular** | *us* | Mpu Tantular → *Bhinneka Tunggal Ika* | **Specialist task SLM, on-device** | **1.5–3B** |

## Positioning map

The market clusters on two axes: **size/generality** and **who it is built for**.

```
        GENERALIST / BIG (7-70B)
                 |
   SEA-LION *    |    * Merah Putih (sovereign, gov)
   (regional,    |
    multi-SEA)   |    * Sahabat-AI (consumer, telco scale)
                 |
-----------------+-------------------------------  who it's for
                 |
   Komodo *      |
   (regional     |    # TANTULAR
    languages)   |    (specialist task SLM: safety +
                 |     customer-service, on-device)
                 |
        SPECIALIST / SMALL (1-3B)
```

Nobody else occupies the bottom-right quadrant: **small + task-specialized +
deployable on-prem/edge.** Everyone else is racing for *bigger and more
general*. That empty quadrant is the wedge.

## What Tantular is best at (vs. the incumbents)

Each strength maps to something real in this repository — not aspiration.

1. **Anti-fraud safety as a first-class, measured dimension.**
   The eval rubric scores *safety* and *official-channel routing* explicitly;
   the `tantular:0.1-id-safety` variant hard-refuses OTP/PIN/CVV/APK/remote-access
   scams. Generalists treat safety as a side-constraint; for Tantular it is the
   product. For Indonesian banking/gov — where social-engineering fraud is the
   #1 problem — this is the sharpest edge.

2. **Cost & latency (quality-per-dollar, on-device).**
   1.5–3B runs on a laptop / CPU / edge box; SEA-LION and Sahabat are 8–9B and
   need GPUs. For call-center deflection or an on-prem bank deployment, ~10x
   cheaper inference at comparable *task* quality beats "smarter but expensive."
   Tantular competes on quality-per-token, not raw quality.

3. **Auditability & self-improvement — a method, not just weights.**
   The constrained Gödel-agent mutates its own recipe/policy inside a sandbox,
   validated on a **held-out private split** so it cannot game the metric. None
   of the five ship a transparent, reproducible improvement loop. The pitch is
   "a model that provably gets better on your data, and you can see why," not a
   black box.

4. **Deployability & sovereignty for private data.**
   Runs fully local via Ollama — no data leaves the bank/ministry. Merah Putih
   markets sovereignty at the *nation* level; Tantular delivers it at the
   *deployment* level (on-prem, air-gappable). That is what a compliance officer
   actually buys.

## Where we do NOT compete (state it plainly)

- **General knowledge / open-ended chat** -> SEA-LION, Sahabat win (8–9B, broad
  training).
- **Multi-language breadth** (Javanese, Sundanese, Acehnese) -> Komodo / SEA-LION
  win today; Tantular is ID-first.
- **National-scale consumer reach / brand** -> Sahabat (Indosat+GoTo
  distribution), Merah Putih (state backing).

Conceding these *sharpens* the positioning rather than weakening it.

## The defensible pitch

> "The big Indonesian models are generalists you rent by the GPU. **Tantular is
> the specialist you own** — a small, auditable, safety-hardened SLM that runs on
> your own hardware and is tuned to beat them on *your* customer-service and
> fraud-prevention tasks, at a fraction of the cost."

## Win condition (how we prove it)

Highest **safety + official-channel + actionability** score **per token / per
second** on the **holdout** split — the fair fight, and the one the bake-off
harness already measures:

```bash
python3 -m godel_agent_prototype.benchmark_ollama_models --split holdout \
    --models tantular:0.1-id tantular:0.1-id-safety \
             aisingapore/Llama-SEA-LION-v3-8B-IT csalab/sahabatai1 \
    --out reports/vs_incumbents.json
```

Compare quality-per-cost, not raw quality: a 1.5–3B specialist matching an 8–9B
generalist on the task that ships, at ~10x lower inference cost, is the story.

See also: [NAMING.md](NAMING.md) for the tag scheme and bake-off workflow.
