# Answer-time numeric re-check gate — implementation spec (2026-06-11)

Motivation: in the pack experiments, every recorded fabrication was a mechanically
recomputable misstatement of the pack's own artifacts — so the enforcement can be
deterministic. Consult-mode defaults do not change; the gate instruments them
(per-mode flag telemetry, `GET /api/recheck-telemetry`).

## 1. Checker module — `src/gates/recheck.ts`

Pure TypeScript, no subprocess, no network. Exported API:

```ts
export interface PackArtifacts {
  paramsJson: string;   // packs.params_json
  datasetCsv: string;   // packs.dataset_csv
  columnSpec: string;   // packs.column_spec
  notes: string;        // packs.notes
}
export interface RecheckClaim {
  claim: string;        // verbatim excerpt from the answer (trimmed, <= 240 chars)
  recomputed: string;   // human-readable recomputed value/finding
  verdict: "pass" | "flag";
  kind: "model-prediction" | "constant-quote" | "derived-ratio" | "trend-direction" | "notes-constant";
}
export interface RecheckResult { claims: RecheckClaim[]; flags: number; checked: number; }
export function recheckAnswer(pack: PackArtifacts, answer: string): RecheckResult;
```

`recheckAnswer` must never throw on arbitrary answer text; malformed pack artifacts may
throw (caller wraps). Empty answer / no extractable claims → `{claims: [], flags: 0, checked: 0}`.

Fitted forms (params order as stored by tools/pack/pack_build.py):
- linear: `y = a − b·k`, params `[a, b]`
- sqrt_linear: `y = a − b·k − c·√k`, params `[a, b, c]`
- exponential: `y = a − b·(e^(c·k) − 1)`, params `[a, b, c]`

params_json fields used: `trends[col].forms[name].params|fit_mae|val_mae`, `trends[col].best`,
`index.{min,max}`, `split`, `n_rows`, `shape.{grid,ref,std,val_mae,n_groups,n_val_groups}`,
`shape_cols`, `spec.columns` (roles/units), `sha256`.

### Claim families (HIGH PRECISION — when binding is ambiguous, extract nothing)

Normalize the answer first: strip markdown emphasis, unify unicode minus/en-dashes to `-`,
`√`/`sqrt`, `·`/`*`, thin/nbsp spaces, `≈`/`~` markers. Work per paragraph; within a
paragraph, bind columns/forms by (a) explicit column token (e.g. `t_cutoff_s`, `v_at_1000s`,
`t_to_45c_min` — exact token match from spec.columns) or (b) a quoted formula whose numeric
literals match a stored form's params (each |literal| within 1% of |param|, all params of the
form present) — formula match also binds the form name. Form may also be named in prose
("linear model", "sqrt-linear", "exponential"). A bare index reference uses domain synonyms:
the index/group column name plus generic words "cycle", "batch", "k".

1. **model-prediction** — a number asserted as a named fitted form's output at index k.
   Trigger: paragraph binds a column AND a form (token/formula/prose), sentence contains an
   index reference ("at cycle 130", "batch 110 (...):", "k = 55.5") and a claimed value with
   or without unit. Recompute the named form at k from stored params. Verdict flag iff
   `|claim − recomputed| > max(0.015·|recomputed|, halfUlp(claim))` where halfUlp is half of
   one unit in the claim's last significant digit (handles "≈ 42.1" vs 42.136, and trailing-zero
   claims like "~2590" get halfUlp = 5). k must lie within or modestly beyond the envelope
   (allow extrapolation up to 2× index.max — claims beyond that are not extracted).
   Do NOT attempt inverse claims ("reaches 1.40 Ah at cycle 134") in v1.

2. **constant-quote** — a number quoted as a stored pack constant: per-form params, fit/val
   MAEs ("validation MAE", "held-out MAE", "MAE"), envelope bounds, n_rows, shape val_mae.
   Flag ONLY when the sentence binds column+field unambiguously (e.g. "validation MAE of the
   linear model is ±0.0322 Ah" with capacity_ah bound in the paragraph) and no matching stored
   constant exists within `max(0.005·|stored|, halfUlp(claim))`. If a quoted constant matches
   ANY plausible binding, verdict pass. Sign rendering differs between doc and answers —
   compare absolute values.

3. **derived-ratio** — percentage claims derived from a quantity plus a dataset value at a
   cited index. Trigger: one sentence contains a quantity X whose unit matches a value
   column's unit, a percentage Y%, and ≥1 explicit index reference (cycle/batch K, possibly
   "both cycle 1 and cycle 110"). For EACH cited K: candidates = { X/v, 1 − X/v } for every
   value column v with matching unit, v = dataset value at index K (and the fitted-best
   prediction as fallback if K not in dataset). Pass if any candidate within ±3 percentage
   points of Y; else flag that K (one claim per failing K, one passing claim if all pass).

4. **trend-direction** — directional assertions about a bound fitted form or the measured
   record. Trigger: paragraph binds a column (token or formula); sentence contains an
   early-direction phrase: ("decays|drops|falls|declines" ... "at first|initially|quickly at
   first|fast initial") → claimed early sign NEGATIVE; ("rises|increases|grows" + same
   qualifiers) → POSITIVE. Two sub-targets, extracted independently when triggered:
   - model: sentence references the form/term ("√k term", "model", "fitted", "trend") →
     compute the bound form's slope sign over the early window (k from index.min to
     index.min + 0.15·(max−min), sampled; "mixed" if sign changes → no flag).
   - data: sentence references observation ("observed", "measured", "data show", "pattern of")
     → early window trend of the dataset column: compare mean of first 3 points vs value at
     the 15% envelope point (use a margin: difference must exceed 1e-9 to count as a sign).
   Flag iff computed sign is opposite to claimed sign. One sentence can yield both a model
   and a data claim (battery U2 does).
   Sanity: thermal answers discussing the cooling curve SHAPE (temperature falling within a
   batch) bind T_c/shape, which genuinely declines — must pass. Only extract when binding is
   explicit; "loaded voltage" prose without a bound column in the paragraph → extract nothing.

5. **notes-constant** — protocol constants asserted from operator notes. Parse notes for
   `charge ... <num> A` and `discharge ... <num> A` (first match each). Extract claims ONLY
   from assertive past/stative protocol statements:
   `/\b(?:was|were|is|been|cell)\s+(?:charged|cycled|discharged)\b[^.;]*?\bat\s+(\d+(?:\.\d+)?)\s*A(?:\s*\/\s*(\d+(?:\.\d+)?)\s*A)?/i`
   and `/\bcharged?\s+at\s+(\d+(?:\.\d+)?)\s*A\b/i`. A pair "X A/Y A" asserts charge=X,
   discharge=Y. Hypotheticals ("doubles to 4 A", "changing to 4 A", "at 4 A the IR drop")
   must NOT match. Flag on mismatch vs notes (rel tol 1e-6). If notes contain no parseable
   currents, extract nothing.

   Additionally (thermal span case): sentence pattern `<num> min ... <num>% of ... span` with
   a group reference ("batch 110", "that batch" with batch N named in the same sentence) →
   recompute fraction = (t − min(x)) / (max(x) − min(x)) over the dataset rows of that group
   (shape_cols gives group/x columns). ±3pp tolerance. Classify kind "derived-ratio".

## 2. Persistence + API — `src/consult.ts`, `src/routes/consult.ts`, `src/packs.ts`

Schema (init alongside packs in `initPacksSchema` or a sibling `initConsultsSchema` called
from server startup):

```sql
CREATE TABLE IF NOT EXISTS consults (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  extraction_id TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('lens+pack','pack-only')),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  model TEXT,
  claims_checked INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  recheck_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_hash TEXT NOT NULL,
  FOREIGN KEY (pack_id) REFERENCES packs(id)
);
CREATE INDEX IF NOT EXISTS idx_consults_pack ON consults(pack_id);
CREATE INDEX IF NOT EXISTS idx_consults_mode ON consults(mode);
```

`/api/ask` changes (BOTH return paths that involve a pack — the pack-only early return and
the lens+pack v3 path):
- fetch the full artifact columns when loading the pack (params_json, dataset_csv,
  column_spec, notes alongside pack_doc);
- after `callConsult`, run `recheckAnswer` wrapped in try/catch — a checker error must not
  fail the consult: log `console.error`, use `{claims:[],flags:0,checked:0}` and store
  `recheck_json` as `{"error":"..."}`;
- INSERT the consult row (id: same generator as pack ids), mode = packDoc && row ? 'lens+pack'
  : 'pack-only';
- response gains `recheck: {claims, flags, checked}`.
Lens-only consults (no pack) are unchanged and NOT persisted — the gate has nothing to check
there ("where applicable", session prompt §2).

Telemetry endpoint:
`GET /api/recheck-telemetry` → `{ modes: [{ mode, consults, claims_checked, flags,
flagged_consults, claim_flag_rate, consult_flag_rate }] }` aggregated with one GROUP BY query.
This number is the preregistered unlock condition for heavier mechanisms — keep it exact.

## 3. UI — `public/modules/consult.js` + `consult.css`, `packs.js`

- consult.js renders the model-provenance element after each answer (`data.model`, ~line 324).
  When `data.recheck` exists, append a sibling badge:
  - `flags > 0` → `⚠ N of M numeric claims failed re-check` (alert styling);
  - `flags === 0 && checked > 0` → `✓ M numeric claims re-checked` (ok styling);
  - `checked === 0` → `– no numeric claims to re-check` (muted).
  Click toggles a per-claim list: verdict icon, claim excerpt, `recomputed`. Title attribute on
  the badge: "Deterministic re-check of numeric claims against the pack's stored artifacts.
  Covers numeric artifact-derived claims only; prose misattribution is not gated."
- packs.js intro blurb: add one sentence — answers consulted against a pack get an answer-time
  numeric re-check; numeric artifact-derived claims only, prose misattribution remains
  verifier-only.

## 4. Fixtures + regression suite — `test/recheck.test.ts`, `test/fixtures/recheck/`

Fixture extraction (one-time, byte-exact — use python sqlite3, NEVER the sqlite3 CLI):
- packs `e27197df5b61` (battery) and `bd9ab5f1838b` (thermal) → write
  `battery.pack.json` / `thermal.pack.json` each `{params_json, dataset_csv, column_spec, notes}`
  (store the raw strings verbatim).
- answers recorded in the pack experiments:
  - offenses: `battery-regression/ans-U1.md`, `ans-U2.md`, `ans-U3.md`,
    `ans-U3__d26612cb.md` (thermal GROUNDED U3)
  - clean: `battery-regression/ans-T1..T6.md` (6) and thermal GROUNDED + PACK T answers:
    `ans-T1__ad5c15e3, ans-T2__6b064ddc, ans-T3__6e554f66, ans-T4__f001a04c,
    ans-T5__2b977a76, ans-T6__0f30ec7c` (GROUNDED), `ans-T1__cfceb15c, ans-T2__a7093004,
    ans-T3__9896f2ee, ans-T4__4d2022a2, ans-T5__bdc0405a, ans-T6__d982341a` (PACK).

Required assertions (bun test):
1. battery U1 → exactly 1 flag; flagged claim contains `2590`; recomputed contains `2536.8`.
   AND the `0.0322` MAE quote, if extracted, has verdict pass.
2. battery U2 → exactly 3 flags: (a) derived-ratio at cycle 110 (claim contains `70`,
   recomputed ≈ 61.6%); (b) trend-direction model (recomputed notes the form RISES initially);
   (c) trend-direction data (recomputed notes measured rise to ~cycle 21).
3. battery U3 → exactly 1 flag: notes-constant, claim contains `2 A/2 A` (or normalized
   equivalent), recomputed cites charge `1.5 A`. The legitimate "2 A discharge" statements and
   all "4 A" hypotheticals must NOT be extracted as flags.
4. thermal U3 GROUNDED → exactly 1 flag: span fraction, claim contains `54`, recomputed
   `62.5`. AND ≥ 2 passing model-prediction claims (the 42.1 / 32.9 / 37.5 bullets) — proves
   the checker actually parses this answer.
5. Each of the 18 clean T answers → 0 flags (table-driven test, one case per file).
6. Edge cases: empty answer → checked 0/flags 0; answer with numbers but no bindable
   anchors ("the answer is 42 and 7% better") → 0 claims; pack with no trends (shape-only)
   handled; malformed params_json → throws (caller catches).
7. Mutation check (tests must be able to fail): one test feeds battery U1 with the claim
   number edited to `2537` and asserts 0 flags — proves the flag comes from the arithmetic,
   not from pattern-matching the fixture text.

Tolerances are spec'd above; if a clean T answer trips a false positive, tighten BINDING
(extraction), never widen numeric tolerance past spec without recording the change in this
file under a "## Deviations" section.

## 5. Constraints

- Bun runtime; bun:sqlite; no new deps. No `any`; immutable style; no console.log outside
  error paths.
- recheck.ts target ≤ ~400 lines; split a claims-extraction helper file if it grows past 800.
- Build-check: `cd website && bun build server.ts --target=bun --outdir=/tmp/x` must pass.
- Do NOT restart the server; do NOT call /api/ask (rate budget); do NOT modify pack rows.
- Sibling sessions may touch this repo: re-read server.ts immediately before editing.

## Addendum — live-recall hardening (2026-06-11, post-implementation)

Five production smoke consults (deepseek-v4-pro) initially yielded `checked: 0` each: the
fixture answers were markdown-styled, live pro answers are LaTeX-styled. Extraction (never
tolerance) was widened; every shape is now a fixture + mutation test (`battery-live-latex`,
`battery-live-latex-2`, `battery-live-bullets`, `thermal-live-latex`,
`thermal-live-sign-error`):

1. `\text{...}`/`\mathbf{...}` unwrapping (no `\b` before the macro — digits glue),
   `\,`/`\ ` spacing, `\times`/`\cdot`/`·` → space, coefficient×10^e → e-notation.
2. Display math joins its paragraph inline (newlines collapsed); a short digit-free
   connective ("gives") between math blocks continues the derivation chain.
3. Newlines split sentences only before structural lines (bullets/tables/headings);
   soft-wrapped prose joins. A single-letter coefficient before an index word
   ("b k = 0.36") is not an index reference.
4. Block-level pairing fallback when a paragraph has exactly ONE index ref and ONE
   (col, form) binding (bullet derivations: "At cycle 90:" … result 3 bullets later).
   Guards: MAE/error-context values are never prediction candidates; a best candidate
   >25% off the recomputation is treated as mis-extraction (extract nothing, never flag).

Smoke consult 5 was a true positive caught live: the model dropped the minus sign on
T_at_20min_c linear b and answered 51.21 °C where its own cited fit gives 60.47 °C at
batch 100 — a sign-error fabrication on a plain numeric ask (T-style, not narrative).
The "fabrication concentrates in narrative answers" finding describes where it
concentrates, not where it is absent.
