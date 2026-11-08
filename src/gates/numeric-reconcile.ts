// numeric-reconcile: offline numeric provenance + acceptance diff between a source
// text and an extracted artifact layer (see docs/CHANNEL-SEPARATION-DOCTRINE.md).
// Two directions:
//   untraceable[] — candidate numbers in the artifact absent from the source
//                   (provenance: fabrication surface)
//   missing[]     — load-bearing source numbers absent from the artifact
//                   (acceptance: content-channel starvation)
// Pure TS, no LLM, no network. Builds on recheck.ts normalize/halfUlp — the
// number-dialect machinery is shared, never reimplemented.
//
// Scope (honest): covers numeric starvation/fabrication and (report-only)
// named-entity starvation. Does NOT cover misattributed-real-numbers or
// qualitative starvation — the answer-sampling fidelity instrument owns those.

import { normalize, halfUlp } from "./recheck.ts";

export interface NumToken {
  value: number;
  literal: string;
  index: number; // char offset in the NORMALIZED text
  percent: boolean;
  uncertainty: boolean; // the ±Y component of an "X ± Y" error bar
}

export interface UntraceableFinding {
  literal: string;
  value: number;
  occurrences: number;
  context: string; // first occurrence, normalized-text window
  measuredContext: boolean; // result/measurement language around the number
}

// Measured-claim context: the number is presented as a finding (result/measurement
// language nearby). Such a number is never repaired to "synthesized" — it traces or
// it flags (V2 letter, Phase 2 repair policy). Report field; gates compare counts.
const MEASURED_CUE = /\b(result|measur|report|observ|accura|score|error|loss|drop|increas|decreas|improv|achiev|perform|benchmark|eval|table|±)/i;
export function isMeasuredContext(context: string): boolean {
  return MEASURED_CUE.test(context);
}

export interface MissingFinding {
  literal: string;
  value: number;
  context: string; // source dense-region window
}

export interface EntityFinding {
  phrase: string;
  present: boolean;
}

export interface RegionStat {
  start: number; // line range in the reference-cut source
  end: number;
  loadBearing: number; // de-duplicated against earlier regions (first region owns a value)
  coverage: number;
  gateEligible: boolean; // loadBearing >= REGION_GATE_MIN_LB
}

export interface ReconcileResult {
  untraceable: UntraceableFinding[];
  tracedDirect: number;
  tracedDerived: number;
  artifactCandidates: number; // distinct candidate values checked
  missing: MissingFinding[];
  loadBearing: number; // distinct load-bearing source numbers
  coverage: number; // global, report-only; 1 when loadBearing = 0 (vacuous pass)
  minRegionCoverage: number; // the acceptance gate metric; 1 when no eligible regions
  regionStats: RegionStat[];
  entities: EntityFinding[]; // report-only telemetry
}

// ── frozen parameters (Phase-1 verdict doc is the freeze record) ──────────────
const YEAR_MIN = 1900;
const YEAR_MAX = 2099;
const BIG_INT_MIN = 1000; // integers below this are structural noise, not candidates
const REL_DERIVED = 0.005; // recheck REL_CONSTANT — derived-combo relative tolerance
const REL_ROUND_CAP = 0.025; // cap on halfUlp tolerance, relative to the reference value
const SENTENCE_WINDOW = 240; // chars around an artifact number searched for combo operands
const CONTEXT_CHARS = 90; // reported context window
const REGION_LINES = 10; // dense-region window height (lines)
const REGION_STEP = 5;
const REGION_MIN_COUNT = 8; // candidate numbers a window needs to count as dense
// Acceptance gate: minimum per-region coverage over gate-eligible regions. Targets
// the V1 mechanism directly — a whole headline table dropped (VPUR region cov 0.09)
// — and is robust to dilution by giant benchmark grids no KE carries in full
// (calibration: VCUR min-region 0.38 vs VPUR 0.09; global coverage only separated
// 0.496 vs 0.367). Regions with fewer load-bearing numbers than REGION_GATE_MIN_LB
// are too noisy to gate on (a 2-number region scores 0 or 1) and stay report-only.
const REGION_STARVED = 0.2; // a gate-eligible region below this coverage = starvation
const REGION_GATE_MIN_LB = 10;
const REFS_HEADING = /^\s*(?:#+\s*)?(?:\d+\.?\s+)?(references|bibliography|works cited)\s*$/im;
// A dense region that is actually a bibliography block (papers with appendices keep
// references mid-document, so heading-based tail-cutting cannot excise them):
// two or more citation signatures = reference region, excluded from load-bearing.
const REF_SIGNATURES = [/\bISSN\b/i, /\bdoi\b/i, /\barXiv\b/i, /\d+\(\d+\):\s*\d+\s*[-–]\s*\d+/, /\bIn Proceedings\b/i, /\bpp\.\s*\d+/i];
function isReferenceRegion(text: string): boolean {
  return REF_SIGNATURES.filter((re) => re.test(text)).length >= 2;
}

const NUM_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/gi;

// Section/structural-numbering dialect: "### 1.1 Salting…", "(Section 1.3)",
// "…ontological. 1.5 The body…". Form is short two-part X.Y; context must show a
// heading position (line start / sentence start followed by a Capitalized word) or a
// structural cross-reference keyword. Measured values with ≥3 fraction digits
// (0.571, 7.197) never match the form.
// leading "-" allowed: the tail of a hyphenated range ("Sections 3.1-3.7" tokenizes
// 3.1 then -3.7) is a label too, but only via the keyword path below
const LABEL_FORM = /^-?\d{1,2}\.\d{1,2}$/;
// keyword (plural allowed) + optional ":"/"#" + optionally earlier labels in a
// comma/range list, so every item in "[Section 3.1, 3.3]" and "Sections 3.1-3.7"
// is covered
const LABEL_KEYWORD = /(?:section|§|chapter|part|step|rule|item|principle|commitment|tension|prediction|algorithm|line|eq(?:uation)?\.?|table|figure|fig\.?|appendix)s?\s*[:#]?\s*\(?\s*(?:\d{1,2}(?:\.\d{1,2})+\s*[,;&-]?\s*(?:and\s+)?)*$/i;
// inside an unclosed citation-tag bracket ("[Section: Abstract, 2, 3.3" …) every
// short X.Y token is a cross-reference, whatever separates the list items. Scoped to
// LABEL_FORM tokens only, so a real value quoted inside a [Context: …] tag is kept.
const CITATION_BRACKET = /\[\s*(?:source|section|context|ref(?:erence)?s?|page|ch(?:apter)?|sec)\b[^\][]*$/i;
function isSectionLabel(normText: string, literal: string, idx: number): boolean {
  if (!LABEL_FORM.test(literal)) return false;
  const before = normText.slice(Math.max(0, idx - 90), idx);
  const after = normText.slice(idx + literal.length, idx + literal.length + 8);
  if (LABEL_KEYWORD.test(before)) return true;
  if (CITATION_BRACKET.test(before)) return true;
  if (literal.startsWith("-")) return false; // range tail needs the keyword path
  // an explicit markdown heading marker immediately before the number ("\n### 1.16 pH")
  // already makes the heading reading unambiguous, so the following word's case is
  // irrelevant — a KE-generated outline heading may begin with a lowercase term
  // ("pH Determination"). Without a marker we still require a capitalized following
  // word so plain "X.Y value" prose at a bare line/sentence start is not absorbed.
  const headingMarker = /(?:^|\n)\s*#{1,6}\s*$/.test(before);
  // heading position: followed by a capitalized word (all-caps allowed: "2.7 NVIDIA")
  const headingFollows = headingMarker || /^\.?\s+["'("]?[A-Z]/.test(after);
  if (!headingFollows) return false;
  // table-body signature: a bare numeric column cell whose preceding line is itself a
  // bare number is never a section heading — it is the last value before a caption or
  // model-name row in a ragged PDF→text table ("70.7\n68.4\n\nTable 14"). A real
  // "X.Y Heading" label is preceded by prose or a heading marker, never a lone number.
  const prevLineNumeric = /(?:^|\n)\s*-?\d+(?:\.\d+)?\s*(?:\n\s*)*$/.test(before);
  if (prevLineNumeric) return false;
  const lineStart = /(?:^|\n)\s*#{0,6}\s*$/.test(before);
  const sentenceStart = /[.!?:]\s+$/.test(before);
  return lineStart || sentenceStart;
}

function tokenize(normText: string): NumToken[] {
  const out: NumToken[] = [];
  for (const m of normText.matchAll(NUM_RE)) {
    const literal = m[0];
    const idx = m.index ?? 0;
    // skip digits glued to a word on the left (identifiers like "v2", "JEPA-2" pass
    // through the \b-less regex via the match start; reject letter-adjacency)
    const prev = idx > 0 ? normText[idx - 1] : " ";
    if (/[a-zA-Z_]/.test(prev)) continue;
    const value = Number.parseFloat(literal);
    if (!Number.isFinite(value)) continue;
    if (isSectionLabel(normText, literal, idx)) continue;
    const after = normText.slice(idx + literal.length, idx + literal.length + 9);
    const percent = /^\s*(?:%|percent\b)/i.test(after);
    // error-bar magnitude: the ±Y in "X ± Y" (also "+/-"). Not an independently
    // citable measurement — see dialectMatch and the load-bearing filter.
    const beforeTok = normText.slice(Math.max(0, idx - 4), idx);
    const uncertainty = /(?:±|\+\/-|\+-)\s*$/.test(beforeTok);
    out.push({ value, literal, index: idx, percent, uncertainty });
  }
  return out;
}

function isCandidate(t: NumToken): boolean {
  if (t.percent) return true;
  if (/[.e]/i.test(t.literal)) return true;
  const v = Math.abs(t.value);
  if (v >= YEAR_MIN && v <= YEAR_MAX && Number.isInteger(t.value)) return false;
  return v >= BIG_INT_MIN;
}

// Rounding tolerance comes from the CLAIMING side's literal only (recheck's
// principle: the claimed literal defines its own rounding), capped relative to the
// reference value so a coarse literal ("1000", halfUlp 500) cannot absorb distant
// values. Compared on absolute values (sign dialect: recheck constant-quote behavior).
function traceTol(claimLit: string, refValue: number): number {
  return Math.min(halfUlp(claimLit), REL_ROUND_CAP * Math.abs(refValue));
}

// Percent dialect closure, claim-side only: an artifact "43.2%" traces to a source
// 0.432 or 43.2. A source percent never excuses a bare artifact fraction — that is
// the laundering direction (the V1 fabricated 0.013 would trace through an unrelated
// source "1.3%"). `claim` is the token whose literal sets the tolerance.
function dialectMatch(claim: NumToken, ref: NumToken): boolean {
  // An error-bar magnitude is not a citable point value: a bare claim must not trace
  // to a source "±Y" (the V1 fabricated 0.013 sits on source "±1.3e-2"). A claim that
  // is itself ±-marked may trace to a source ± of the same value.
  if (ref.uncertainty && !claim.uncertainty) return false;
  const c = Math.abs(claim.value);
  const r = Math.abs(ref.value);
  if (Math.abs(c - r) <= traceTol(claim.literal, ref.value)) return true;
  if (claim.percent) {
    if (Math.abs(c - r * 100) <= traceTol(claim.literal, ref.value * 100)) return true;
    if (Math.abs(c / 100 - r) <= traceTol(claim.literal, ref.value)) return true;
  }
  return false;
}

function tracesDirect(t: NumToken, pool: NumToken[]): boolean {
  return pool.some((s) => dialectMatch(t, s));
}

// Fused column-code repair (binding, never tolerance). normalize()'s space-grouped
// thousands joiner — `(\d) (?=\d{3}\b)` — eats the space in a table cell written
// "<code>/<d> <value>" (e.g. "0956/2 525.2"), gluing the code's trailing digit onto
// the value: "0956/2525.2". The instrument then reads a phantom "2525.2". The
// signature is unambiguous: the token sits immediately after "/", the char before
// "/" is a digit (a "<digits>/<digit>" cell code), and the token carries a decimal.
// We peel exactly the one fused leading digit and re-check against the source. This
// can only RECOVER a genuine source value — the peeled literal must itself trace, so
// a real fabrication (peeled value absent from source) still flags. No number is
// widened; the claimed value is reconstructed to what the artifact actually wrote.
function tracesByDepeel(t: NumToken, normText: string, pool: NumToken[]): boolean {
  const i = t.index;
  if (i < 2 || normText[i - 1] !== "/" || !/\d/.test(normText[i - 2])) return false;
  if (!t.literal.includes(".") || !/^\d/.test(t.literal)) return false;
  const peeledLit = t.literal.slice(1);
  const peeledVal = Number.parseFloat(peeledLit);
  if (!Number.isFinite(peeledVal)) return false;
  const peeled: NumToken = { ...t, value: peeledVal, literal: peeledLit };
  return tracesDirect(peeled, pool);
}

// Derived recognition: t ≈ a op b where a and b are directly-traceable numbers from
// the SAME artifact sentence window (an honest derivation shows its operands), or one
// operand is the constant 1 or 100 (complements, percent conversion). Global
// pair-combination search over the source is deliberately NOT done — with hundreds of
// source numbers it would launder fabrications through the combo space.
function tracesDerived(t: NumToken, artifactTokens: NumToken[], sourcePool: NumToken[]): boolean {
  const near = artifactTokens.filter(
    (o) =>
      o !== t &&
      Math.abs(o.index - t.index) <= SENTENCE_WINDOW &&
      tracesDirect(o, sourcePool),
  );
  const operands = near.map((o) => Math.abs(o.value));
  const consts = [1, 100];
  const target = Math.abs(t.value);
  const tol = Math.max(halfUlp(t.literal), REL_DERIVED * target);
  const ok = (x: number) => Number.isFinite(x) && Math.abs(x - target) <= tol;
  for (let i = 0; i < operands.length; i++) {
    for (const c of consts) {
      if (ok(operands[i] + c) || ok(Math.abs(operands[i] - c)) || ok(operands[i] * c) || ok(operands[i] / c) || ok(c / operands[i])) return true;
    }
    for (let j = 0; j < operands.length; j++) {
      if (i === j) continue;
      const a = operands[i];
      const b = operands[j];
      if (ok(a + b) || ok(Math.abs(a - b)) || ok(a * b) || (b !== 0 && ok(a / b))) return true;
    }
  }
  return false;
}

// cut everything from the last references/bibliography heading in the back half
export function cutReferences(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= Math.floor(lines.length * 0.4); i--) {
    if (REFS_HEADING.test(lines[i])) return lines.slice(0, i).join("\n");
  }
  return text;
}

interface DenseRegion {
  start: number;
  end: number;
  count: number;
  text: string;
}

export function denseRegions(normSource: string): DenseRegion[] {
  const lines = normSource.split("\n");
  const counts = lines.map((l) => tokenize(l).filter(isCandidate).length);
  const flagged = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += REGION_STEP) {
    const end = Math.min(i + REGION_LINES, lines.length);
    let c = 0;
    for (let j = i; j < end; j++) c += counts[j];
    if (c >= REGION_MIN_COUNT) for (let j = i; j < end; j++) flagged[j] = true;
  }
  const regions: DenseRegion[] = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && flagged[i]) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      const text = lines.slice(start, i).join("\n");
      regions.push({ start, end: i, count: tokenize(text).filter(isCandidate).length, text });
      start = -1;
    }
  }
  return regions;
}

// keyword matches either case; the label capture stays strict (capital or digit)
const ENTITY_RE = /\b(?:[Vv]ariant|[Mm]odel|[Mm]ethod|[Cc]ondition|[Cc]onfig(?:uration)?|[Ss]etting|[Cc]ase|[Ee]xperiment)\s+([A-Z][A-Za-z0-9-]{0,15}|\d+[A-Za-z]?)\b/g;

function regionEntities(regions: DenseRegion[]): string[] {
  const seen = new Set<string>();
  for (const r of regions) {
    for (const m of r.text.matchAll(ENTITY_RE)) seen.add(m[0]);
  }
  return [...seen];
}

function context(normText: string, index: number): string {
  return normText
    .slice(Math.max(0, index - CONTEXT_CHARS), index + CONTEXT_CHARS)
    .replace(/\s+/g, " ")
    .trim();
}

export function numericReconcile(source: string, artifact: string): ReconcileResult {
  const normSourceFull = normalize(source);
  const normArtifact = normalize(artifact);
  const sourcePool = tokenize(normSourceFull);
  const artifactTokens = tokenize(normArtifact);

  // provenance direction
  const candidates = artifactTokens.filter(isCandidate);
  const byLiteral = new Map<string, NumToken[]>();
  for (const t of candidates) {
    const key = t.percent ? `${t.literal}%` : t.literal;
    const group = byLiteral.get(key);
    if (group) group.push(t);
    else byLiteral.set(key, [t]);
  }
  const untraceable: UntraceableFinding[] = [];
  let tracedDirect = 0;
  let tracedDerived = 0;
  for (const [key, group] of byLiteral) {
    const t = group[0];
    if (tracesDirect(t, sourcePool) || tracesByDepeel(t, normArtifact, sourcePool)) {
      tracedDirect++;
      continue;
    }
    if (tracesDerived(t, artifactTokens, sourcePool)) {
      tracedDerived++;
      continue;
    }
    const ctx = context(normArtifact, t.index);
    untraceable.push({
      literal: key,
      value: t.value,
      occurrences: group.length,
      context: ctx,
      measuredContext: isMeasuredContext(ctx),
    });
  }

  // acceptance direction — dense regions of the reference-cut source; bibliography
  // blocks that survive the tail cut (appendix-bearing papers) drop by signature
  const normSourceCut = normalize(cutReferences(source));
  const regions = denseRegions(normSourceCut).filter((r) => !isReferenceRegion(r.text));
  const missing: MissingFinding[] = [];
  const regionStats: RegionStat[] = [];
  const seenKeys = new Set<string>();
  let loadBearing = 0;
  let presentTotal = 0;
  for (const r of regions) {
    let regionLb = 0;
    let regionPresent = 0;
    for (const t of tokenize(r.text)) {
      if (!isCandidate(t)) continue;
      if (t.uncertainty) continue; // error bars are not load-bearing point values
      const key = t.percent ? `${t.literal}%` : t.literal;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      regionLb++;
      // the artifact token is the claiming side — it may round the source value
      if (artifactTokens.some((a) => dialectMatch(a, t))) {
        regionPresent++;
      } else {
        missing.push({ literal: key, value: t.value, context: context(r.text, t.index) });
      }
    }
    loadBearing += regionLb;
    presentTotal += regionPresent;
    regionStats.push({
      start: r.start,
      end: r.end,
      loadBearing: regionLb,
      coverage: regionLb === 0 ? 1 : regionPresent / regionLb,
      gateEligible: regionLb >= REGION_GATE_MIN_LB,
    });
  }
  const coverage = loadBearing === 0 ? 1 : presentTotal / loadBearing;
  const eligible = regionStats.filter((r) => r.gateEligible);
  const minRegionCoverage = eligible.length === 0 ? 1 : Math.min(...eligible.map((r) => r.coverage));

  const entities: EntityFinding[] = regionEntities(regions).map((phrase) => ({
    phrase,
    present: normArtifact.toLowerCase().includes(phrase.toLowerCase()),
  }));

  return {
    untraceable,
    tracedDirect,
    tracedDerived,
    artifactCandidates: byLiteral.size,
    missing,
    loadBearing,
    coverage,
    minRegionCoverage,
    regionStats,
    entities,
  };
}

export function acceptancePass(r: ReconcileResult): boolean {
  return r.minRegionCoverage >= REGION_STARVED;
}

export const FROZEN_PARAMS = {
  YEAR_MIN,
  YEAR_MAX,
  BIG_INT_MIN,
  REL_DERIVED,
  REL_ROUND_CAP,
  SENTENCE_WINDOW,
  REGION_LINES,
  REGION_STEP,
  REGION_MIN_COUNT,
  REGION_STARVED,
  REGION_GATE_MIN_LB,
} as const;
