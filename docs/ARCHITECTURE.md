# Architecture

One Bun process: an HTTP server, background jobs on the same event loop, SQLite
(WAL) for state, and a chat-completions endpoint for every model call. No build
step, no runtime dependencies beyond Bun; grounding packs shell out to Python.

## Request path

```
Bun.serve (src/server.ts)
  └─ createFetchHandler (src/app.ts)
       ├─ /api/*  → POST must be application/json → first matching Route in API_ROUTES
       └─ else    → serveStatic (src/routes/static.ts): public/, /e/:id lens pages
```

Each handler receives a `RequestContext` (`src/router.ts`): the request, URL, client
IP and its salted hash, and the `AppContext`. `AppContext` is the `Engine`
(config, db, llm) plus per-process state: job slots, rate limiters, the view
de-duplicator, and the merge-preview cache. Nothing lives in module globals, so a
test can build a complete app in-process (`test/api.test.ts`).

Long work (extraction, merge, interview synthesis, logic test, pack build) is
started without awaiting and holds one of five job slots until it settles. Status
lives in the row (`pending → phase1 … phase6 → complete | failed`); clients poll.
On boot, rows left in a non-terminal state are marked `failed` (`src/db.ts`).

## Modules

| Path | Role |
|---|---|
| `src/config.ts` | Environment → typed `Config` |
| `src/db.ts` | Schema, additive migrations, stuck-job recovery |
| `src/llm.ts` | `complete` / `chat` / `consult` over the chat-completions API |
| `src/prompts.ts` | Every prompt. Injected documents are wrapped in nonce-tagged delimiters |
| `src/pipeline/extraction.ts` | Phases 1–6 and data minimization; external-S completion; understanding upgrade |
| `src/pipeline/knowledge.ts` | K agents, chunk regrouping, VK verification |
| `src/pipeline/knowledge-core.ts` | Core tiering: the model selects unit numbers, code rebuilds the text (lossless) |
| `src/pipeline/understanding.ts` | U1 → U2 → VU, one corrective rewrite |
| `src/pipeline/gates.ts` | Write-path gate wrappers (quote gate, numeric reports) |
| `src/pipeline/grounding.ts` | Entity extraction/matching, claim–passage pairing |
| `src/pipeline/merge.ts` | Multi-altitude and dialogue merges, root-lineage audit |
| `src/pipeline/interview.ts` | Coverage tracking, steering, transcript → lens, enrichment with rollback |
| `src/pipeline/logic-test.ts` | Bare vs. lens answers to one scenario |
| `src/gates/*` | Deterministic checkers (pure functions, unit-tested) |
| `src/consult.ts` | Lens router; persistence of consult-time checks |
| `src/okf.ts` | OKF bundle build, validation, tar.gz |
| `src/packs.ts` | Pack schema, input validation, build → verify-at-write via `tools/pack/*.py` |
| `src/routes/*` | HTTP handlers grouped by area |

## Data model

`src/schema.sql` plus the tables created in `src/db.ts` and `src/packs.ts`:

| Table | Holds |
|---|---|
| `extractions` | Lenses: source text, LD/KE/core/UD, grounding report, profile, status, visibility |
| `merges` | Merge jobs and their parents; the result is a new `extractions` row with `merge_id` |
| `interviews` | Transcript, coverage, tracker notes, owner key |
| `logic_tests` | Scenario, bare and lens answers |
| `packs` | CSV, column roles, generated document, parameters, verification report |
| `consults` | Pack consults with re-check verdicts (telemetry) |
| `lens_consults` | Lens-only consults with grounding reports |
| `flags` | One row per flagger; three distinct flaggers hide a lens |

## Trust boundaries

- Origins: in production, browser POSTs need `ALLOWED_ORIGIN`.
- Client identity is a salted IP hash; interviews may use an 8-hex client key instead.
  Both are rate-limit and ownership keys, not authentication.
- `/api/internal/*` needs `INTERNAL_API_TOKEN` (≥ 32 chars) in `x-internal-token`.
- Lenses are readable by id in any status; `is_public` only controls listing.
