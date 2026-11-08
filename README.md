# Logic Extraction

Distill a document, or an interview with someone who knows their craft, into a
**lens**: a compressed, source-grounded package of *how that mind reasons*, *what it
knows*, and *how the two connect*. Mount the lens on a general-purpose model and it
answers new questions in that domain the way the source would, while deterministic
checks keep every quote and number traceable to the original.

> **A note from the author.** I built this earlier this year. I don't yet see the
> direct use for it, but it is genuinely interesting, and it works: it's pretty cool
> that you can hand a model such an abstract data format and it can act on the basis
> of it. This repository publishes the process as it is: experimental research code.

## What a lens is

| Layer | Carries | Never carries |
|---|---|---|
| **Logic Document (LD)** | Reasoning moves: what the source attends to, how it weighs options, which inferences it licenses, where its commitments pull against each other | Facts. Quotes appear only as anchors for a move |
| **Knowledge Extract (KE)** | Prescriptive and conditional knowledge: what to do, with what, how much, when, and what to watch for, with source citations | Re-derived reasoning frameworks |
| **Understanding Document (UD)** | How reasoning and knowledge meet: why the moves work given what the source knows | Synthesis presented as source fact |
| **Grounding pack** *(optional)* | Measured data plus fitted models from a CSV, with a validated envelope | Anything not recomputable from the CSV |

The separation is deliberate. Mixing channels, i.e. reconstructing content inside the
reasoning layer or re-deriving reasoning inside the content layer, turned out to be
the main source of fabrication. See
[`docs/CHANNEL-SEPARATION-DOCTRINE.md`](docs/CHANNEL-SEPARATION-DOCTRINE.md).

## How it works

```
source ─┬─ A  reasoning moves ─┐
        ├─ B  commitments      ├─ V  verify each finding ─ S  synthesize ──► Logic Document
        └─ C  tensions         ┘   + meta-check             P  profile

LD + source ── K  prescriptive + conditional knowledge ── VK verify claims ──► Knowledge Extract
LD + KE ────── U1 connection map ── U2 write ── VU audit (one rewrite) ─────► Understanding Document

every write ── quote gate · numeric reconcile · entity grounding  (deterministic, no LLM)
```

- **Phase 1** runs three blind agents in parallel; long sources are chunked at
  paragraph boundaries and the per-chunk reports merged.
- **Phase 2** verifies every finding against the source, per agent, plus a meta-level
  check. An experimental cross-synthesis agent (X) exists but is off by default
  because in validation it added net fabrication.
- **Phases 3–6** write the LD, extract and verify knowledge, tier the KE into a
  *core* subset for consults, and synthesize the UD.
- **Data minimization:** intermediate agent outputs are deleted once a lens is complete.

Other ways to make or use a lens:

- **Interview:** an adaptive interviewer draws out how someone reasons; a coverage
  tracker steers toward the weakest dimension (core logic, commitments, evaluation,
  tensions). The transcript becomes the source, so every quote in the lens must trace
  to the person's own words. A later interview can enrich an existing lens.
- **Consult:** ask a question with a lens mounted (three prompt styles, five context
  depths, flash or reasoning tier). A router can pick the best lens for a question or
  abstain. Answers get a consult-time grounding report.
- **Merge:** combine two lenses (peer, asymmetric, awareness, thematical). Merged
  documents are gated against the **root** ancestors, never against intermediate
  merges, because gating against a merge launders its fabrications into "parent truth".
- **Logic test:** the same scenario answered bare and with the lens, side by side.
- **Export:** any lens as an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle (markdown + YAML frontmatter).

## Verification

LLM verifiers (V, VK, VU) are useful but not trusted alone. Every write path runs
deterministic gates that caught fabrications the LLM reviewers missed:

| Gate | Checks |
|---|---|
| **Quote gate** (`src/gates/quote-check.ts`) | A quoted span that cannot be found in the source loses its quotation marks: the content stays, the false "this is verbatim" claim goes |
| **Numeric reconcile** (`src/gates/numeric-reconcile.ts`) | Numbers in KE/UD that cannot be traced to the source are labelled before the UD is written; load-bearing source numbers missing from the KE are reported |
| **Entity grounding** (`src/pipeline/grounding.ts`) | Numbers with units, names, quoted terms, and timings in LD/KE/UD are matched against the source |
| **Re-check** (`src/gates/recheck.ts`) | Pack consults: every model prediction, constant, ratio, and trend in the answer is recomputed from the pack's own artifacts ([spec](docs/RECHECK-GATE-SPEC.md)) |
| **Consult grounding** (`src/gates/consult-grounding.ts`) | Lens consults: names, acronyms, citations, and numbers in the answer that appear neither in the source nor in the lens |
| **Lineage** (`src/gates/lineage.ts`) | Merges: the gate corpus is the set of root (non-merged) ancestors |

Gates annotate and repair. They never silently drop content, and every result is
stored in the lens's `grounding_report`.

## Quick start

Requires [Bun](https://bun.sh) (tested with 1.4) and a [DeepSeek](https://platform.deepseek.com) API key.

```sh
git clone https://github.com/jp290/logic-extraction
cd logic-extraction
bun install
cp .env.example .env        # set DEEPSEEK_API_KEY
bun start                   # http://localhost:3471
```

A short document takes roughly 15–25 model calls on the extraction tier
(`deepseek-chat`); consults can use the reasoning tier (`deepseek-v4-pro`).

Grounding packs, and the test suite, additionally need Python with numpy and scipy:

```sh
python3 -m venv tools/pack/.venv
tools/pack/.venv/bin/pip install -r tools/pack/requirements.txt
```

## Example

[`examples/cooking-interview/`](examples/cooking-interview/) contains a real
interview transcript about cooking without recipes, plus the lens the interview
module produced from it, exported as an OKF bundle.

## Configuration

All settings are environment variables; [`.env.example`](.env.example) documents each one.

| Variable | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | (required) | Model access |
| `PORT` / `HOST` | `3471` / `127.0.0.1` | Listen address |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base for canonical links in exports and lens pages |
| `DATA_DIR` | `./data` | Location of `extractions.db` |
| `NODE_ENV`, `ALLOWED_ORIGIN` | | Production mode rejects cross-origin browser requests unless `ALLOWED_ORIGIN` matches |
| `IP_HASH_SALT` | random per boot | Salt for hashed client IPs (rate limits, ownership) |
| `RATE_LIMIT_MINUTES`, `MAX_WORDS` | `60`, `400000` | Extraction window and source size limit |
| `INTERNAL_API_TOKEN` | (disabled) | ≥ 32 chars enables `/api/internal/*` |
| `CROSS_SYNTHESIS_ENABLED` | `0` | Experimental agent X |
| `PACK_PYTHON` | `tools/pack/.venv/bin/python` | Python for grounding packs |

## HTTP API

| Route | Purpose |
|---|---|
| `POST /api/extract` | Start an extraction (`text`, optional `title`, `mode: "logic" \| "understanding"`, `is_public`) |
| `GET /api/extractions/:id` | A lens and its status (poll until `complete`) |
| `GET /api/extractions` · `/titles` | Public lenses: paging, search, sort, filters |
| `GET /api/extractions/:id/okf` | OKF bundle as `.tar.gz` (`?format=json` for a manifest) |
| `POST /api/ask` | Consult a lens, a pack, or both; `route: true` lets the router choose |
| `POST /api/ask-compare` | One question under the three prompt styles |
| `POST /api/merge/preview` · `/api/merge` | Compatibility preview; start a merge |
| `POST /api/interview/start` · `/message` · `/synthesize` | Interview flow |
| `POST /api/packs` | Build a grounding pack from CSV + column roles |
| `POST /api/test` · `/api/generate-scenarios` | Logic tests |
| `POST /api/upgrade-understanding/:id` | Add KE + UD to a logic-only lens |
| `GET /api/workflows` | Every agent prompt, with placeholders |
| `/api/internal/*` | Token-gated: pause before phase 3 so a stronger model can write the LD |

## Development

```sh
bun test              # unit tests, API failure paths, golden master (needs tools/pack/.venv, see Quick start)
bun run typecheck     # tsc --strict
```

The **golden master** (`test/golden/`) boots the engine against a deterministic mock
LLM, drives every route through one scenario, and compares three things with the
recording: the HTTP responses, the multiset of model requests (hashed full bodies),
and the final database state. It is how the move from one 3,400-line file to modules
was shown to be behaviour-preserving. After an intended behaviour change, re-record
with `bun run golden:record` and review the diff. The pack steps need the Python
environment above (or `PACK_PYTHON`).

```
src/
  server.ts           entry point
  app.ts, router.ts   route table and request context
  config.ts, db.ts, llm.ts, http.ts, limits.ts, text.ts
  prompts.ts          every agent prompt
  pipeline/           extraction, knowledge, understanding, merge, interview, gates
  gates/              deterministic checkers
  routes/             HTTP handlers by area
  okf.ts, packs.ts, consult.ts
public/               browser UI (no build step)
tools/                regate.ts, backfill-core-ke.ts, pack/ (Python pack builder + verifier)
test/                 unit tests, fixtures, golden master
docs/                 design notes
```

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Running it publicly

- Keep `HOST=127.0.0.1` behind a reverse proxy. The engine trusts `X-Forwarded-For`
  only from loopback and uses its first entry, so the proxy must **set** that header
  to the real client address (e.g. from `CF-Connecting-IP` behind Cloudflare). A proxy
  that passes the visitor's own header through, or appends to it, lets clients pick
  their IP and walk past every rate limit.
- Set `NODE_ENV=production`, `ALLOWED_ORIGIN`, and a fixed `IP_HASH_SALT`.
- Source texts are stored in the database (the gates need them). Treat the
  database as containing everything users uploaded.
- Every extraction costs model calls. The built-in limits are per IP (6 extractions
  per window, 30 consults per hour, 3 merges per hour) plus 5 concurrent jobs.

## Limitations

- Model names and token budgets are tuned for DeepSeek; other providers would need
  changes in `src/config.ts` and `src/llm.ts`.
- The gates verify quotes, numbers, and named entities. They cannot verify
  conceptual structure the model invents. That is why deep, many-lens merges stay
  unreliable, and why the lens is a reasoning aid rather than a source of record.
- This is research code from a single author. Expect rough edges.

## License

[AGPL-3.0-only](LICENSE). © 2026 jp290.
