# Channel-Separation Doctrine

**The law:** an artifact layer earns its place only by carrying a channel the
deployment model lacks. Mixing channels is the project's dominant failure mode.

## The three channels

| Channel | What it carries | Lives in | Earns its place when |
|---|---|---|---|
| **First derivative (dynamics)** | How the source reasons — moves, transitions, licensed inferences | LD | At distance from the deployment model's defaults (lens-distance law) |
| **Zeroth derivative (content)** | What the source says/measured — facts, records, citations | KE / UD / packs | Private, measured, or OOD; always checkable |
| **Grounding (anti-collapse)** | Quote-gate + recheck gate | Deterministic gates | Always on. Floor, never headline |

Corollaries:
- A dynamics artifact that reconstructs content produces unverifiable prose
  (fabrication surface). A content artifact that re-derives dynamics the model
  already has costs accuracy. Grounding keeps the dynamics channel honest but
  cannot gate manufactured conceptual structure.
- External mirror: the JEPA-school argument that removing reconstruction
  pressure (not latent prediction per se) is what declutters world models — the
  three-layer split is the in-context version of that channel split.

## Evidence (one row per experiment)

Rows summarize the project's internal experiment write-ups, which are not part of
this repository; treat them as the author's research notes, not as reproducible claims.

| Experiment | Result | Channel-mixing diagnosis |
|---|---|---|
| Toulmin slot-filling vs "how does this text think?" (2026-05) | Schema extraction shallow; abstract prompt found predictive dynamics | Content-shaped boxes imposed on the dynamics channel — slot-filling is reconstruction pressure |
| 11-merge study (2026-06-04) | Parent distance > merge type; thematical most reliable | Distance is the dynamics channel's value term; thematical works because it keeps content concrete instead of abstracting it into prose |
| JEPA field lens, n=4 | FAIL pre-registered criteria; PAPERS won, specialists swept home turf | Merging blends distinct content channels into diluted synthesis; raw content (PAPERS) beat it inside the context window |
| Cross-synthesis Agent X | Won preference 9/9, added net fabrication (3 vs 1) — NOT SHIPPED | X mined "system-level" dynamics with no content-channel access; ungrounded dynamics got stated as content claims |
| FIELD12, 12-paper scale | Preference won OOD; fidelity audit inverted it (15 vs 0 contradicted); routing validated | Monolithic merge launders 12 content channels into synthesized prose — provenance compounds away with depth. Routing preserves each content channel intact |
| FIELD12 rebuild under root grounding | Still FAIL (29 vs 11 contradicted); concept-level fabrication survives | Grounding gates the zeroth derivative (quotes, numbers) but cannot gate manufactured conceptual structure — deep merges mix synthesized dynamics into the content channel where no gate reaches |
| Agent-S tier sweep | Guards don't fix DeepSeek-S; S invents orderings/verdicts the source contradicts | S over-structuring = dynamics imposed on content: invented algorithms where the source says "mix and match" |
| Grounded transition lens probe | Usefulness FAIL, fidelity PASS; interpolation substrate won, trend extrapolation lost | Pack carried *fitted* dynamics (a model) in the content channel; the deployment model out-predicted it. Measured content (V(x) table) won — measure, don't model |
| Execution-trace probe | Accuracy gate FAIL on textbook sort costs; fidelity flawless | Content channel filled with in-distribution material — re-deriving what the model already knows costs accuracy. Lens-distance law confirmed for packs |
| Preference vs fidelity (three occurrences: X, n=4 voicings, FIELD12 OOD) | Preference panels rewarded fabricated specificity every time | Instrument-level mixing: preference measures the dynamics channel's persuasiveness, fidelity measures the content channel's truth — they are different instruments and must both run, with a baseline arm |
| Quote-gate + recheck gate | 17 fabrications caught that an LLM judge missed; live sign-error true positive; 3 consecutive live-calibration wins | The grounding channel working as designed — deterministic, always-on, and strictly a floor (quality-over-receipts) |

## The decision filter

Before building or changing an artifact layer, ask:

1. **Which channel is this?** If the answer mixes two, stop and split.
2. **Does the deployment model already carry it?** (Model-prior pre-flight.)
   In-distribution dynamics or content → the layer costs accuracy; don't build.
3. **Is it checkable?** Content must carry citations to measured/quotable
   source; dynamics must be grounded in source moments; anything deterministic
   goes in a gate, not a prompt rule.
4. **Is the instrument split too?** Preference AND fidelity AND a baseline arm —
   never one alone.

Prompt-design consequences (the purification rules):
- **LD prompts: no facts, only moves.** Dynamics extraction only; content
  reconstruction explicitly forbidden. Quotes appear only as grounding anchors
  for a move, never as knowledge payload.
- **KE/UD prompts: content + citations only.** No re-derivation of evaluation
  logic or reasoning frameworks; stated decision rules are content, derived
  ones are not.
- **Enforcement goes deterministic.** When a gate takes over a rule (as the
  quote gate took S rule 10), shrink the prompt rule back to intent.
