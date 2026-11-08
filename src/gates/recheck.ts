// Answer-time numeric re-check gate (spec: docs/RECHECK-GATE-SPEC.md). Pure TS, no
// subprocess/network. Recomputes numeric claims an answer makes against a grounding
// pack's stored artifacts and flags those the pack contradicts. High precision: when
// binding is ambiguous, extract nothing.

export interface PackArtifacts {
  paramsJson: string;
  datasetCsv: string;
  columnSpec: string;
  notes: string;
}

export interface RecheckClaim {
  claim: string;
  recomputed: string;
  verdict: "pass" | "flag";
  kind: "model-prediction" | "constant-quote" | "derived-ratio" | "trend-direction" | "notes-constant" | "final-estimate";
}

export interface RecheckResult {
  claims: RecheckClaim[];
  flags: number;
  checked: number;
}

type FormName = "linear" | "sqrt_linear" | "exponential" | "nlogn" | "quadratic";

interface FormFit {
  params: number[];
  fit_mae: number;
  val_mae: number;
}

interface ColumnTrend {
  forms: Partial<Record<FormName, FormFit | { failed: true }>>;
  best: FormName | null;
}

interface ColumnRole {
  role: string;
  unit?: string;
}

interface Params {
  trends: Record<string, ColumnTrend>;
  index: { min: number; max: number } | null;
  split: [number, number] | null;
  shape: { val_mae: number } | null;
  shapeCols: [string, string, string] | null;
  columns: Record<string, ColumnRole>;
}

const REL_PREDICTION = 0.015;
const REL_CONSTANT = 0.005;
const RATIO_TOL_PP = 3;
const EXTRAPOLATION_FACTOR = 2;
const FORM_LITERAL_REL = 0.01;
const SIGN_EPS = 1e-9;
const NOTES_REL = 1e-6;

// ── form evaluation ───────────────────────────────────────────────

function evalForm(form: FormName, params: number[], k: number): number {
  const [a, b, c] = params;
  if (form === "linear") return a - b * k;
  if (form === "sqrt_linear") return a - b * k - c * Math.sqrt(Math.abs(k));
  // nlogn/quadratic share the y = a − b·g(k) convention (b stored negative for an
  // increasing trend). Basis matches build_pack.py EXACTLY: k·log2(k) for k>1 else 0.
  if (form === "nlogn") return k > 1 ? a - b * k * Math.log2(k) : a;
  if (form === "quadratic") return a - b * k * k;
  return a - b * (Math.exp(c * k) - 1);
}

function fitOf(trend: ColumnTrend, form: FormName): FormFit | null {
  const f = trend.forms[form];
  if (!f || "failed" in f) return null;
  return f;
}

// ── pack parsing (may throw on malformed params_json — caller catches) ──

function parsePack(pack: PackArtifacts): Params {
  const raw = JSON.parse(pack.paramsJson) as unknown;
  if (typeof raw !== "object" || raw === null) throw new Error("params_json not an object");
  const obj = raw as Record<string, unknown>;
  const trendsRaw = (obj.trends ?? {}) as Record<string, unknown>;
  const trends: Record<string, ColumnTrend> = {};
  for (const [col, t] of Object.entries(trendsRaw)) {
    if (typeof t !== "object" || t === null) continue;
    const tt = t as Record<string, unknown>;
    const formsRaw = (tt.forms ?? {}) as Record<string, unknown>;
    const forms: ColumnTrend["forms"] = {};
    for (const name of ["linear", "sqrt_linear", "exponential", "nlogn", "quadratic"] as FormName[]) {
      const fr = formsRaw[name];
      if (typeof fr !== "object" || fr === null) continue;
      const f = fr as Record<string, unknown>;
      if (f.failed === true || !Array.isArray(f.params)) {
        forms[name] = { failed: true };
      } else {
        forms[name] = {
          params: (f.params as unknown[]).map(Number),
          fit_mae: Number(f.fit_mae),
          val_mae: Number(f.val_mae),
        };
      }
    }
    const best = typeof tt.best === "string" ? (tt.best as FormName) : null;
    trends[col] = { forms, best };
  }
  const idxRaw = obj.index;
  let index: { min: number; max: number } | null = null;
  if (idxRaw && typeof idxRaw === "object") {
    const i = idxRaw as Record<string, unknown>;
    index = { min: Number(i.min), max: Number(i.max) };
  }
  const splitRaw = obj.split;
  const split = Array.isArray(splitRaw) && splitRaw.length === 2
    ? ([Number(splitRaw[0]), Number(splitRaw[1])] as [number, number])
    : null;
  const shapeRaw = obj.shape;
  const shape = shapeRaw && typeof shapeRaw === "object"
    ? { val_mae: Number((shapeRaw as Record<string, unknown>).val_mae) }
    : null;
  const scRaw = obj.shape_cols;
  const shapeCols = Array.isArray(scRaw) && scRaw.length === 3
    ? ([String(scRaw[0]), String(scRaw[1]), String(scRaw[2])] as [string, string, string])
    : null;

  let columns: Record<string, ColumnRole> = {};
  let specCols: unknown;
  if (obj.spec && typeof obj.spec === "object") {
    specCols = (obj.spec as Record<string, unknown>).columns;
  }
  if (!specCols) {
    try {
      const cs = JSON.parse(pack.columnSpec) as unknown;
      specCols = cs;
    } catch {
      specCols = {};
    }
  }
  if (specCols && typeof specCols === "object") {
    for (const [name, v] of Object.entries(specCols as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const vv = v as Record<string, unknown>;
        columns[name] = {
          role: typeof vv.role === "string" ? vv.role : "",
          unit: typeof vv.unit === "string" ? vv.unit : undefined,
        };
      }
    }
  }
  return { trends, index, split, shape, shapeCols, columns };
}

// ── dataset parsing ──────────────────────────────────────────────

interface Dataset {
  header: string[];
  rows: number[][];
}

function parseCsv(csv: string): Dataset {
  const lines = csv.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { header: [], rows: [] };
  const header = lines[0].split(",").map((h) => h.trim());
  const rows: number[][] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => Number(c.trim()));
    if (cells.length === header.length) rows.push(cells);
  }
  return { header, rows };
}

// ── normalization ────────────────────────────────────────────────

export function normalize(text: string): string {
  return text
    .replace(/[−–—‐‑]/g, "-")
    .replace(/[    ]/g, " ")
    .replace(/√/g, "sqrt")
    .replace(/·/g, " ")
    .replace(/[≈~]/g, " ")
    // Division sign → "/" so a ratio derivation written "31775 ÷ 43011 ≈ 0.7388" grounds
    // through the same "X / Y" quotient path the ratio-window family already recognizes.
    .replace(/÷/g, "/")
    // LaTeX thin-space thousands separators ("16,\!777,\!216", "4,\!248,\!154.78") must
    // be joined to a bare number BEFORE the comma-stripper and before the generic
    // `\\[,;! ]` → " " rule (which would otherwise shatter the group into "16, 777, 216").
    // Same two-pass shape as the plain-comma stripper: pass 1 catches alternating groups,
    // pass 2 the rest. "4,\!248,\!154.78" → "4248154.78"; the {3}\b boundary leaves a
    // 4-digit group untouched.
    .replace(/(\d),\\!(?=\d{3}\b)/g, "$1")
    .replace(/(\d),\\!(?=\d{3}\b)/g, "$1")
    // LaTeX "\," thin-space thousands separators ("\frac{31\,775}{43\,011}") join to a
    // bare number HERE — critically BEFORE the generic `\\[,;! ]` → " " rule below, which
    // would otherwise turn "31\,775" into "31 775" only AFTER the space-grouping pass has
    // already run, leaving the group shattered. Mirrors the `\!` rule exactly: two passes
    // for alternating groups, {3}\b boundary leaves a 4-digit group untouched.
    .replace(/(\d)\\,(?=\d{3}\b)/g, "$1")
    .replace(/(\d)\\,(?=\d{3}\b)/g, "$1")
    // Space-grouped thousands ("94 973", "106 496", "94 972.92808"). Runs AFTER the
    // unicode-space mapping above, so a thin/narrow space is already a plain space.
    // digit + single space + exactly-3-digits + \b, two passes for alternating groups.
    // The {3}\b boundary leaves a 4-digit group ("58 8321") and a comma+space list
    // ("values 1, 234") untouched. It WILL join "1 500"-style enumerations — that
    // ambiguity is accepted (spec) in exchange for catching space-grouped numbers.
    .replace(/(\d) (?=\d{3}\b)/g, "$1")
    .replace(/(\d) (?=\d{3}\b)/g, "$1")
    // Strip thousands-separator commas inside a number EARLY (before any rewrite that
    // depends on digit adjacency): "93,606" → "93606", "1,234,567" → "1234567". A single
    // global pass only catches alternating groups in "1,234,567" (the comma after "234"
    // sits inside the just-consumed "567" lookahead), so run it twice. The {3}\b boundary
    // means "1, 234" (comma+space) and 4-digit groups ("58,8321") are left untouched.
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    // Period-grouped thousands ("100.000", "1.000.000" — European separator). Mirrors
    // the comma rule but the period is the dialect-ambiguous case: it is ALSO the decimal
    // point, so the lookahead only fires when the run is UNAMBIGUOUSLY grouped — either a
    // following ".ddd" group ("1.000.000" → the first period sees "000.000") or a ".000"
    // group, which a real decimal never is (trailing-zero decimals don't survive to here
    // and "x.000" as a measured value is not written). A lone "0.408" has neither: no
    // second group, and "408" ≠ "000", so it is left untouched. Two passes for alternating
    // groups, exactly like the comma rule above.
    .replace(/(\d)\.(?=\d{3}\.\d{3}\b|000\b)/g, "$1")
    .replace(/(\d)\.(?=\d{3}\.\d{3}\b|000\b)/g, "$1")
    // coefficient×10^e → e-notation BEFORE multiplication signs become spaces,
    // so "8.17026\times10^{-6}" stays one literal instead of "8.17026 10"
    .replace(/(\d(?:\.\d+)?)\s*(?:\\times|×|\*|·|x)\s*10\^\{?(-?\d+)\}?/gi, "$1e$2")
    // LaTeX degree macros → "°" (the unicode the unit comparison expects). Covers
    // "^{\circ}", "^\circ", "{\circ}", a bare "\circ", and "\degree". Done BEFORE the
    // backslash strip below, which would otherwise leave "^{circ}" wedged between the
    // value and its unit letter ("56.674 ^{circ}C") and break value↔unit adjacency.
    .replace(/\^?\s*\{?\s*\\(?:circ|degree)\s*\}?/g, "°")
    // Spelled-out unit words → their canonical symbol, but ONLY when attached to a
    // number (a value's unit). "40.86 minutes" → "40.86 min", "3.55 volts" → "3.55 V",
    // "1.40 amp-hours" → "1.40 Ah". A bare "minutes"/"volts" in prose is left alone, so
    // a column's prose name ("time to 45 °C") is never rewritten into a unit token. The
    // value↔unit adjacency the unit matcher relies on is what these answers spell out.
    .replace(/(\d(?:\.\d+)?)(\s*)(?:minutes|mins)\b/gi, "$1$2min")
    .replace(/(\d(?:\.\d+)?)(\s*)seconds\b/gi, "$1$2s")
    .replace(/(\d(?:\.\d+)?)(\s*)(?:millivolts|millivolt)\b/gi, "$1$2mV")
    .replace(/(\d(?:\.\d+)?)(\s*)(?:volts|volt)\b/gi, "$1$2V")
    .replace(/(\d(?:\.\d+)?)(\s*)(?:milliamp-hours|milliamp-hour|milliampere-hours|milliampere-hour)\b/gi, "$1$2mAh")
    .replace(/(\d(?:\.\d+)?)(\s*)(?:amp-hours|amp-hour|ampere-hours|ampere-hour)\b/gi, "$1$2Ah")
    .replace(/\\(?:times|cdot)\b/g, " ")
    .replace(/\\[,;! ]/g, " ")
    .replace(/\*\*/g, "")
    .replace(/[`*_]/g, "")
    .replace(/\\(?=[a-zA-Z(){}[\],])/g, "")
    // no \b before the macro name: "51.21008text{ °C}" has no digit→letter boundary
    .replace(/(?:text|mathrm|textrm|mathbf|mathit|boldsymbol)\{([^{}]*)\}/g, "$1")
    .replace(/(?:text|mathrm|textrm|mathbf|mathit|boldsymbol)\{([^{}]*)\}/g, "$1");
}

function splitParagraphs(text: string): string[] {
  const blocks = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  // Merge display-math / bullet-list continuations into the preceding prose block so
  // a formula stated on its own line binds the bullets that restate its predictions.
  const merged: string[] = [];
  for (const block of blocks) {
    // A bare connective between display-math blocks ("gives", "so we get") continues
    // the derivation chain — pro answers split "model [formula] gives [evaluation]"
    // across blocks. Digit-free and short, so list items can never merge this way.
    const isConnective =
      merged.length > 0 &&
      /\]\s*$/.test(merged[merged.length - 1]) &&
      block.length <= 60 &&
      /^[A-Za-z\s,]+$/.test(block);
    const isContinuation =
      /^\\?\[/.test(block) || // LaTeX display math
      /^[-*]\s/.test(block) || // bullet list
      isConnective ||
      (merged.length > 0 && /[:=]\s*$/.test(merged[merged.length - 1])); // prev ended with : or =
    const isFormulaOnly = /^[A-Za-z_{}().\d\s=+\-*/^√,\\[\]|]+$/.test(block) && /=/.test(block) && block.length < 200 && !/[.;]/.test(block.replace(/\d\.\d/g, ""));
    if ((isContinuation || isFormulaOnly) && merged.length > 0) {
      // Display math and connectives are one derivation: join inline and collapse
      // internal newlines so "Evaluating at k = 120:" and "... = 2603.86 s" become
      // one sentence. Bullets keep their newlines — each pairs independently.
      const inline = /^\\?\[/.test(block) || isFormulaOnly || isConnective;
      const sep = inline ? " " : "\n";
      const body = inline ? block.replace(/\n+/g, " ") : block;
      merged[merged.length - 1] = merged[merged.length - 1] + sep + body;
    } else {
      merged.push(block);
    }
  }
  return merged;
}

// A structural break ends a derivation chain: a markdown heading, or a short
// all-caps label line ("FINAL ESTIMATE: ...", "ANSWER: ...") that introduces a
// summary rather than continuing the working. Breaks reset the carried binding.
function isStructuralBreak(para: string): boolean {
  if (/^#{1,6}\s/.test(para)) return true;
  const head = para.split(/[\n.]/)[0].trim();
  return /^[A-Z][A-Z \t]{2,40}:/.test(head);
}

function splitSentences(para: string): string[] {
  // Sentence punctuation always breaks. A newline breaks only before a structural
  // line (bullet, table row, heading, numbered item) — soft-wrapped prose joins,
  // so "For batch 95, the model\n(formula)\nyields 40.86 min" stays one sentence.
  return para
    .split(/(?<=[.;])\s+|\n+(?=\s*(?:[-*#|]|\d+[.)]\s))/)
    .map((s) => s.replace(/\n+/g, " ").trim())
    .filter((s) => s.length > 0);
}

// halfUlp: half of one unit in the claimed number's last significant digit.
export function halfUlp(literal: string): number {
  const m = literal.match(/-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  const s = m[0];
  if (s.includes(".")) {
    const decimals = s.split(".")[1].length;
    return 0.5 * Math.pow(10, -decimals);
  }
  // integer: trailing zeros set the last significant digit (2590 -> ulp 10, half 5)
  const trimmed = s.replace("-", "");
  const trailingZeros = trimmed.length - trimmed.replace(/0+$/, "").length;
  if (trailingZeros === 0) return 0.5;
  return 0.5 * Math.pow(10, trailingZeros);
}

// A quantity is delta-marked when a difference cue ("Δ", "delta", "change of/in",
// "drop of", "difference of") appears in the prose immediately preceding it (within a
// short window, no sentence-ending punctuation between). Such a quantity is a derived
// difference, never a stored pack constant — so it must not be a constant-quote
// candidate. "Δ" survives normalize (only the underscores after it are stripped).
function isDeltaMarked(sentence: string, literalStart: number): boolean {
  const before = sentence.slice(Math.max(0, literalStart - 60), literalStart);
  // The cue must be the nearest difference phrase with no intervening clause break.
  const window = before.split(/[.;:]/).pop() ?? before;
  return /(?:Δ|\bdelta\b|\bchange\s+(?:of|in)\b|\bdrop\s+of\b|\bdifference\s+of\b)/i.test(window);
}

// ── binding helpers ──────────────────────────────────────────────

const INDEX_WORDS = ["cycle", "batch", "k"];

function indexColumn(p: Params): string | null {
  for (const [name, r] of Object.entries(p.columns)) {
    if (r.role === "index" || r.role === "group") return name;
  }
  return null;
}

function valueColumns(p: Params): string[] {
  return Object.entries(p.columns)
    .filter(([, r]) => r.role === "value")
    .map(([name]) => name);
}

// Find a value column whose token appears in the paragraph. Normalization strips
// underscores, so match both the raw token and its underscore-stripped form.
function boundColumnTokens(para: string, p: Params): string[] {
  const found: string[] = [];
  for (const col of Object.keys(p.trends)) {
    const stripped = col.replace(/_/g, "");
    const re = new RegExp(`\\b(?:${escapeRe(col)}|${escapeRe(stripped)})\\b`, "i");
    if (re.test(para)) found.push(col);
  }
  return found;
}

// Near-token (prefix) column binding. The text contains an identifier-like token
// that is a STRICT prefix of exactly one trend column's underscore-stripped name.
// e.g. "Tat20min" → T_at_20min_c (stripped "Tat20minc"); "tto45c" → t_to_45c_min
// (stripped "tto45cmin"). A token that is a prefix of two or more columns, or an
// exact column match, is excluded here (exact matches are already covered above).
//
// The token MUST contain a digit. Real column identifiers carry their measurement
// in the name ("20min", "45c", "1000s"), so a digit-bearing prefix is an identifier
// reference; a plain dictionary noun that merely happens to prefix a column name
// ("capacity" → capacity_ah, "discharge") never carries a digit and so never binds
// here. This keeps measured-value prose ("Cycle 1 discharge capacity: 1.8565 Ah")
// from being mis-bound as a model prediction.
function nearTokenColumns(para: string, p: Params): string[] {
  const stripped = Object.fromEntries(
    Object.keys(p.trends).map((c) => [c, c.replace(/_/g, "").toLowerCase()])
  );
  const tokens = para.match(/[A-Za-z][A-Za-z0-9]{3,}/g) ?? [];
  const out = new Set<string>();
  for (const raw of tokens) {
    if (!/\d/.test(raw)) continue; // identifier-like only: must carry a digit
    const tok = raw.toLowerCase();
    const prefixHits = Object.keys(p.trends).filter(
      (c) => stripped[c] !== tok && stripped[c].startsWith(tok)
    );
    if (prefixHits.length === 1) out.add(prefixHits[0]);
  }
  return [...out];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The set of columns that participate in trend binding: those carrying a stored
// trend (value/summary columns). Index/group/x/y columns never bind a form, so a
// unit shared only with a non-trend column (e.g. an "x" axis column) does not
// break unit-uniqueness among the bindable set.
function bindableColumns(p: Params): string[] {
  return Object.keys(p.trends);
}

// The single trend-bearing column carrying `unit`, or null when zero or more than
// one share it. Unit-uniqueness is the gate for prose-register (synonym) binding:
// only a column whose unit pins it unambiguously may bind without a token/formula.
// Battery: Ah→capacity_ah and s→t_cutoff_s are unique; V is shared by v_at_1000s
// and v_at_1800s, so bare-V prose must NEVER synonym-bind. Thermal: °C→T_at_20min_c
// and min→t_to_45c_min are each unique among trend columns.
function unitUniqueColumn(p: Params, unit: string): string | null {
  if (!unit) return null;
  const u = normUnit(unit);
  const hits = bindableColumns(p).filter((c) => normUnit(p.columns[c]?.unit ?? "") === u && (p.columns[c]?.unit ?? "") !== "");
  return hits.length === 1 ? hits[0] : null;
}

// Canonical prose noun(s) for a measurement unit. Derived mechanically from the
// dimension the unit names — NOT from loose pattern-matching of the column name
// (quantityWords conflates "20min"/"45c" substrings inside column names and would
// give t_to_45c_min a spurious "temperature" noun and T_at_20min_c a spurious
// "time" noun). Since the synonym path selects the column BY its unit-unique unit,
// the noun is the canonical noun for that unit. No free-form synonym list.
function unitNoun(unit: string): string[] {
  const u = normUnit(unit);
  if (u === "ah" || u === "mah") return ["capacity"];
  if (u === "v" || u === "mv") return ["voltage"];
  if (u === "c") return ["temperature"]; // °C normalizes to "c"
  if (u === "min" || u === "s") return ["time", "duration"];
  return [];
}

// Prose-register binding: bind a column WITHOUT a token or formula when a sentence
// (a) carries an explicit-unit value whose unit is unit-unique to one trend column,
// and (b) carries the canonical prose noun for that unit (unitNoun). Returns the
// unit-unique columns whose noun appears in the text. Where the unit is shared (V),
// or the noun is absent, this binds nothing.
function synonymBoundColumns(text: string, p: Params): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const col of bindableColumns(p)) {
    const unit = p.columns[col]?.unit ?? "";
    if (!unit) continue;
    if (unitUniqueColumn(p, unit) !== col) continue; // not unit-unique → no bind
    if (valuesWithUnit(text, unit).length === 0) continue; // need an explicit-unit value
    const nouns = unitNoun(unit);
    if (nouns.length === 0) continue;
    if (nouns.some((w) => lower.includes(w))) out.push(col);
  }
  return out;
}

// Match a quoted formula's literals against a stored form's params.
// Returns {col, form} when all params present within FORM_LITERAL_REL.
function bindByFormula(para: string, p: Params): { col: string; form: FormName }[] {
  const literals = (para.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
  if (literals.length === 0) return [];
  const out: { col: string; form: FormName }[] = [];
  for (const [col, trend] of Object.entries(p.trends)) {
    for (const form of ["linear", "sqrt_linear", "exponential", "nlogn", "quadratic"] as FormName[]) {
      const fit = fitOf(trend, form);
      if (!fit) continue;
      const allPresent = fit.params.every((param) => {
        if (Math.abs(param) < 1e-12) return true; // a ≈ 0 param is unconstrained in prose
        return literals.some((lit) => Math.abs(Math.abs(lit) - Math.abs(param)) <= FORM_LITERAL_REL * Math.abs(param));
      });
      if (allPresent) out.push({ col, form });
    }
  }
  return out;
}

function formInProse(text: string): FormName | null {
  if (/\bsqrt[-\s_]?linear\b|\bsqrt\s*[√]?\s*-?\s*linear\b|square[-\s]?root/i.test(text)) return "sqrt_linear";
  if (/\bexponential\b/i.test(text)) return "exponential";
  // nlogn/quadratic before the bare linear test: "log-linear" / "n log n" prose names
  // the linearithmic form and must NEVER bind plain linear (order is load-bearing).
  if (/n[\s·*]?log[\s_]?2?[\s(]?n|\bnlogn\b|\bn-log-n\b|\blinearithmic\b|\blog-?linear\b/i.test(text)) return "nlogn";
  if (/\bquadratic\b|\bn\^2\b|\bn²\b|\bn\s*squared\b/i.test(text)) return "quadratic";
  if (/\blinear\b/i.test(text)) return "linear";
  return null;
}

// Per-form regexes mirroring formInProse's precedence. Ordered most-specific first:
// a region matched by an earlier (more specific) pattern is masked so its substrings
// can't re-match a later one ("log-linear" must register nlogn, never also linear;
// "sqrt-linear" must register sqrt_linear, never also linear).
const FORM_PATTERNS: { form: FormName; re: RegExp }[] = [
  { form: "sqrt_linear", re: /\bsqrt[-\s_]?linear\b|\bsqrt\s*[√]?\s*-?\s*linear\b|square[-\s]?root/gi },
  { form: "exponential", re: /\bexponential\b/gi },
  { form: "nlogn", re: /n[\s·*]?log[\s_]?2?[\s(]?n|\bnlogn\b|\bn-log-n\b|\blinearithmic\b|\blog-?linear\b/gi },
  { form: "quadratic", re: /\bquadratic\b|\bn\^2\b|\bn²\b|\bn\s*squared\b/gi },
  { form: "linear", re: /\blinear\b/gi },
];

// Every form-name mention in a sentence with its start index, masking already-claimed
// regions in precedence order (so "log-linear" yields one nlogn mention, not nlogn+linear).
function formMentions(sentence: string): { form: FormName; index: number }[] {
  const mask = sentence.split("");
  const out: { form: FormName; index: number }[] = [];
  for (const { form, re } of FORM_PATTERNS) {
    re.lastIndex = 0;
    const masked = mask.join("");
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push({ form, index: m.index });
      for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = "\x00";
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// FIX 1 — multi-form / multi-value pairing. A single sentence that names ≥2 DISTINCT
// trend forms AND carries ≥2 same-unit values ("the linear model's prediction ... (85265
// comparisons) ... the nlogn model's prediction ... (93606 comparisons)") states one value
// PER form. The whole-sentence binding (formInProse → one form) would bind every value to
// that one form and false-flag the others. Instead pair each unit-value with its NEAREST
// PRECEDING form mention and check each pair against ITS OWN form's recompute for the bound
// column. A value with no preceding form mention extracts nothing (high precision). Returns
// true iff the sentence is such a multi-form construction — the caller then skips its normal
// point/forward pairing for this sentence entirely.
function tryMultiFormPairing(
  sentence: string,
  col: string,
  k: number,
  p: Params,
  out: RecheckClaim[]
): boolean {
  const mentions = formMentions(sentence);
  const distinctForms = new Set(mentions.map((m) => m.form));
  if (distinctForms.size < 2) return false;
  const unit = p.columns[col]?.unit ?? "";
  if (!unit) return false;
  const vals = valuesWithUnit(sentence, unit).filter(
    (v) => v.value !== k && !isInputMarkedValue(sentence, v.index)
  );
  if (vals.length < 2) return false;
  if (!inEnvelope(k, p)) return true; // owned, but un-checkable index → silent
  for (const v of vals) {
    // nearest form mention strictly preceding this value
    let chosen: FormName | null = null;
    let bestIdx = -1;
    for (const men of mentions) {
      if (men.index < v.index && men.index > bestIdx) { bestIdx = men.index; chosen = men.form; }
    }
    if (chosen === null) continue; // no preceding form → extract nothing for this value
    const fit = fitOf(p.trends[col], chosen);
    if (!fit) continue;
    if (isFormParam(v.value, fit.params)) continue; // a formula restatement, not the output
    const recomputed = evalForm(chosen, fit.params, k);
    const tol = Math.max(REL_PREDICTION * Math.abs(recomputed), halfUlp(v.literal));
    const verdict = Math.abs(v.value - recomputed) > tol ? "flag" : "pass";
    pushClaim(out, sentence, `${chosen}(${k}) = ${round(recomputed)} for ${col}`, verdict, "model-prediction");
  }
  return true;
}

// Extract index reference k from a sentence (cycle 130, batch 110, k = 55.5).
function extractIndexRefs(sentence: string, p: Params): number[] {
  const ks: number[] = [];
  const idxCol = indexColumn(p);
  const words = [...INDEX_WORDS];
  if (idxCol) words.push(idxCol);
  const wordAlt = words.map(escapeRe).join("|");
  // "cycle 130", "batch 110", "at cycle 1 and cycle 110". A single-letter token
  // right before the index word is a coefficient ("b k = 0.36" in a derivation),
  // not an index reference — reject those.
  const re1 = new RegExp(`(?<!\\b[A-Za-z][\\s*])\\b(?:${wordAlt})\\s*=?\\s*(\\d+(?:\\.\\d+)?)`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re1.exec(sentence)) !== null) ks.push(Number(m[1]));
  return ks;
}

// Like extractIndexRefs but keeps the match position of each index word, so a
// carried-binding pass can pair "at cycle K ... value" left-to-right and reject
// inverse phrasing where the index is the answer stated after the value.
function indexRefsWithPos(sentence: string, p: Params): { k: number; index: number }[] {
  const out: { k: number; index: number }[] = [];
  const idxCol = indexColumn(p);
  const words = [...INDEX_WORDS];
  if (idxCol) words.push(idxCol);
  const wordAlt = words.map(escapeRe).join("|");
  const re1 = new RegExp(`(?<!\\b[A-Za-z][\\s*])\\b(?:${wordAlt})\\s*=?\\s*(\\d+(?:\\.\\d+)?)`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re1.exec(sentence)) !== null) out.push({ k: Number(m[1]), index: m.index });
  return out;
}

// ── claim families ───────────────────────────────────────────────

function pushClaim(
  list: RecheckClaim[],
  sentence: string,
  recomputed: string,
  verdict: "pass" | "flag",
  kind: RecheckClaim["kind"]
): void {
  const claim = sentence.trim().slice(0, 240);
  list.push({ claim, recomputed, verdict, kind });
}

// A difference cue marks a value as a DIFFERENCE between two cited indices, not a
// point prediction at either. Covers the explicit-difference vocabulary spec'd for
// the gate ("difference", "Δ", "delta", "gap", "increase of", "rise of", "drop of",
// "change of", "slower/faster by", "more/less than ... by"). When such a cue appears
// in a sentence that also carries ≥2 distinct index refs, the value is a model-
// prediction DIFFERENCE: a fabricated difference must still flag, but the value must
// NEVER be checked as a point prediction at one of the indices (false positive).
const DIFFERENCE_CUE =
  /\bdifference\b|Δ|\bdelta\b|\bgap\b|\bincrease\s+of\b|\brise\s+of\b|\bdrop\s+of\b|\bchange\s+of\b|\b(?:slower|faster|more|less)\s+(?:by|than)\b/i;

// A derived/non-column quantity noun: the sentence's claimed numbers describe a
// CHANGE in the column (a within-window drop/decrease/fall/rise/gain/delta), not the
// column's own point value. When such a noun heads the quantity AND the sentence pairs
// each claimed value with its OWN index (a per-index list: ≥2 distinct indices and
// ≥2 same-unit values), the values are a derived-quantity list — recomputing within-
// window drops is a new claim family, OUT OF SCOPE — so the bound column's point-
// prediction path must extract NOTHING for them (a true within-batch cooling drop must
// never be flagged against the bound column's point form). A "between X and Y" / "from
// X to Y" window phrase is a strong additional signal but not required. Contrast the
// single-value two-index difference ("yields the 6.8 min difference") which carries one
// value and is owned by tryModelDifference's |f(K2)−f(K1)| recompute instead.
const DERIVED_QUANTITY_CUE =
  /\b(?:drop|decrease|change|delta|difference|fall|falls|fell|rise|rises|rose|gain|gains|decline|declines)\b/i;

// True iff `sentence` is a per-index list of a derived (non-column) quantity bound to
// a column whose unit is `unit`: a derived-quantity cue is present, the sentence names
// ≥2 distinct in-envelope indices, and carries ≥2 same-unit claimed values. Such a list
// must not be read as point predictions of the bound column (FP class A).
function isDerivedPerIndexList(sentence: string, p: Params, unit: string): boolean {
  if (!DERIVED_QUANTITY_CUE.test(sentence)) return false;
  const refs = indexRefsWithPos(sentence, p);
  const distinct = refs.filter((r, i) => refs.findIndex((o) => o.k === r.k) === i);
  if (distinct.length < 2 || !distinct.every((r) => inEnvelope(r.k, p))) return false;
  const vals = valuesWithUnit(sentence, unit).filter((v) => !distinct.some((r) => r.k === v.value));
  return vals.length >= 2;
}

// Prediction-cue vocabulary: a verb (any tense) or noun asserting the value is a
// model OUTPUT, not observed data. Covers "predict/predicts/predicted/prediction",
// "yield(s)", "give(s)", "project(s)/projected". Past tense ("predicted", "projected")
// matters: pro answers headline the result as "Predicted time ... = 40.86 min". A bare
// "took"/"measured" is excluded (observed-data narration). "estimate(d)" is also
// EXCLUDED — "the estimate aligns with the observed progression: batch 10 took ..." is
// a narration of data, not a fresh model output (these verbs sit on observed values).
const PREDICTION_CUE =
  /\b(?:predicts?|predicted|prediction|yields?|gives?|projects?|projected)\b/i;

// A unit-bearing value immediately preceded (within a short window) by an input
// preposition is an INPUT, not an asserted output: "at 33.7 min" / "for 33.7 min"
// names a clock-time / x-axis reading the model maps FROM, never the model's own
// prediction. The carried point-pairing must never treat such a value as a column
// output (the column's unit can equal the x-axis unit — min names both t_to_45c_min
// and the t_min axis — so adjacency, not the bare unit, is what disqualifies it).
const INPUT_PREP_BEFORE = /\b(?:at|for|from|over|near|per)\s+\S*$/i;
function isInputMarkedValue(sentence: string, valueIndex: number): boolean {
  return INPUT_PREP_BEFORE.test(sentence.slice(Math.max(0, valueIndex - 14), valueIndex));
}

// Two distinct in-envelope index references in the sentence, ordered by appearance.
// Returns null unless there are exactly two distinct values (the |f(K2) − f(K1)|
// recompute is only unambiguous for a two-point difference).
function twoDistinctIndices(
  sentence: string,
  p: Params
): { k1: number; k2: number } | null {
  const refs = indexRefsWithPos(sentence, p);
  const distinct = refs.filter((r, i) => refs.findIndex((o) => o.k === r.k) === i);
  if (distinct.length !== 2) return null;
  const ordered = [...distinct].sort((a, b) => a.index - b.index);
  if (!inEnvelope(ordered[0].k, p) || !inEnvelope(ordered[1].k, p)) return null;
  return { k1: ordered[0].k, k2: ordered[1].k };
}

// Model-prediction DIFFERENCE handler. A sentence carrying a difference cue AND two
// distinct cited indices states |f(K2) − f(K1)| of a bound form, not a point value.
// When the binding is clean (exactly one (col, form) candidate, the difference value
// carries that column's unit, and is not itself an index or a form param), recompute
// the difference and flag iff the claim is off by more than the point tolerance —
// so a fabricated difference still flags, the true 6.8 min one passes. If any of
// those is ambiguous, extract NOTHING (never flag). Returns true iff the sentence is
// a two-index difference construction — the caller's point-prediction loop then skips
// it entirely (the value must never be treated as a point prediction at either index).
function tryModelDifference(
  sentence: string,
  candidates: { col: string; form: FormName }[],
  p: Params,
  out: RecheckClaim[]
): boolean {
  if (!DIFFERENCE_CUE.test(sentence)) return false;
  const pair = twoDistinctIndices(sentence, p);
  if (pair === null) return false;
  // From here the sentence is owned: its value is a difference, never a point
  // prediction. Emit only if the recompute is clean; otherwise stay silent.
  const uniq = Array.from(new Set(candidates.map((c) => `${c.col} ${c.form}`)));
  if (uniq.length !== 1) return true;
  const { col, form } = candidates[0];
  const fit = fitOf(p.trends[col], form);
  if (!fit) return true;
  const unit = p.columns[col]?.unit ?? "";
  const vals = valuesWithUnit(sentence, unit).filter(
    (v) => v.value !== pair.k1 && v.value !== pair.k2 && !isFormParam(v.value, fit.params)
  );
  if (vals.length !== 1) return true; // ambiguous claimed difference → extract nothing
  const claimed = vals[0];
  const recomputed = Math.abs(evalForm(form, fit.params, pair.k2) - evalForm(form, fit.params, pair.k1));
  const tol = Math.max(REL_PREDICTION * Math.abs(recomputed), halfUlp(claimed.literal));
  const verdict = Math.abs(claimed.value - recomputed) > tol ? "flag" : "pass";
  pushClaim(
    out,
    sentence,
    `${form}(${pair.k2}) - ${form}(${pair.k1}) = ${round(recomputed)} for ${col}`,
    verdict,
    "model-prediction"
  );
  return true;
}

// Aggregate cue: the claimed value is an aggregate (arithmetic mean / average) of the
// bound form's predictions OVER A RANGE of indices, not a point prediction at any single
// index. "Campaign average (arithmetic mean of predictions for k = 1…110): 37.5 min".
const AGGREGATE_CUE =
  /\b(?:average|mean|averaged|campaign average|midpoint of the campaign|typical(?:\s+value)?\s+(?:across|over|of))\b/i;

// Parse an explicit integer index RANGE: "k = 1…110", "1...110", "1-110", "1 to 110",
// "batches 1 to 110". En/em dashes were unified to "-" by normalize. Returns null when
// no unambiguous range is present (ambiguous → caller extracts nothing, never flags).
function parseIndexRange(sentence: string): { lo: number; hi: number } | null {
  const re = /(?:\b(?:k|batch(?:es)?|cycle)\b\s*=?\s*)?(\d+)\s*(?:…|\.\.\.|-|to)\s*(\d+)/gi;
  const found: { lo: number; hi: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isInteger(a) && Number.isInteger(b) && b > a) found.push({ lo: a, hi: b });
  }
  if (found.length !== 1) return null; // 0 or >1 ranges → ambiguous
  return found[0];
}

// Model-prediction AGGREGATE handler. A sentence carrying an aggregate cue AND an
// explicit index range states the arithmetic mean of a bound form over that range, not a
// point value at any single index. When the binding is clean (exactly one (col, form)
// candidate, the range is within the envelope, exactly one same-unit claimed value that
// is not itself a range endpoint or a form param), recompute the mean over integer
// indices and flag iff the claim is off by more than the standard point tolerance — so a
// fabricated aggregate still flags, the true campaign mean passes. If any of those is
// ambiguous, extract NOTHING (never flag, never a point prediction at a single index).
// Returns true iff the sentence is an aggregate-over-range construction — the caller's
// point-prediction loop then skips it entirely.
function tryModelAggregate(
  sentence: string,
  candidates: { col: string; form: FormName }[],
  p: Params,
  out: RecheckClaim[]
): boolean {
  if (!AGGREGATE_CUE.test(sentence)) return false;
  const range = parseIndexRange(sentence);
  if (range === null) return false;
  // From here the sentence is owned: its value is an aggregate, never a point prediction.
  if (!inEnvelope(range.lo, p) || !inEnvelope(range.hi, p)) return true;
  const uniq = Array.from(new Set(candidates.map((c) => `${c.col} ${c.form}`)));
  if (uniq.length !== 1) return true;
  const { col, form } = candidates[0];
  const fit = fitOf(p.trends[col], form);
  if (!fit) return true;
  const unit = p.columns[col]?.unit ?? "";
  const vals = valuesWithUnit(sentence, unit).filter(
    (v) => v.value !== range.lo && v.value !== range.hi && !isFormParam(v.value, fit.params)
  );
  if (vals.length !== 1) return true; // ambiguous claimed aggregate → extract nothing
  const claimed = vals[0];
  let sum = 0;
  for (let k = range.lo; k <= range.hi; k++) sum += evalForm(form, fit.params, k);
  const recomputed = sum / (range.hi - range.lo + 1);
  const tol = Math.max(REL_PREDICTION * Math.abs(recomputed), halfUlp(claimed.literal));
  const verdict = Math.abs(claimed.value - recomputed) > tol ? "flag" : "pass";
  pushClaim(
    out,
    sentence,
    `mean ${form}(${range.lo}..${range.hi}) = ${round(recomputed)} for ${col}`,
    verdict,
    "model-prediction"
  );
  return true;
}

// Numbers immediately followed by `unit` (within a few non-digit chars), e.g.
// "2536.8 s", "≈ 42.1 min", "= 41.625 min". Unit comparison ignores ° and case.
function valuesWithUnit(sentence: string, unit: string): { value: number; literal: string; index: number }[] {
  if (!unit) return [];
  const u = unit.replace(/°/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // allow optional ° and surrounding spaces before the unit token
  const re = new RegExp(`(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)\\s*°?\\s*${u}\\b`, "gi");
  const out: { value: number; literal: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    // An MAE/error quote ("validation MAE 0.0066 V") is not a value asserted AS
    // the column's output — never pair it as a prediction.
    const before = sentence.slice(Math.max(0, m.index - 40), m.index);
    if (/\bMAE\b|mean absolute error|noise floor/i.test(before)) continue;
    out.push({ value: Number(m[1]), literal: m[1], index: m.index });
  }
  return out;
}

function isFormParam(value: number, params: number[]): boolean {
  return params.some((p) => p !== 0 && Math.abs(Math.abs(value) - Math.abs(p)) <= 1e-9);
}

function inEnvelope(k: number, p: Params): boolean {
  if (!p.index) return true;
  const hi = p.index.max * EXTRAPOLATION_FACTOR;
  return k >= Math.min(p.index.min, 0) && k <= hi;
}

// A best candidate more than this fraction off the recomputation is treated as a
// mis-extraction (an aside, not the prediction) — extract nothing rather than flag.
// Real fabrications (sign errors, ~2-40% off) sit between tol and this window AND
// carry the column's own unit, so the unit-conflict gate below keeps them flagging.
const MISEXTRACT_WINDOW = 0.25;

// True iff the sentence asserts a numeric value carrying an explicit unit that
// belongs to some OTHER value column and is incompatible with `col`'s unit. This
// signals the sentence is really about a different column (e.g. a "3.55 V" voltage
// claim mis-bound to a t_cutoff_s/seconds column). The threshold/input value in a
// genuine prediction ("At 1.40 Ah the model projects 2500 s") also trips this, so
// callers gate it behind the mis-extraction window: a foreign-unit value only
// suppresses when the matched same-unit candidate is implausibly far off too.
function assertsForeignValueUnit(sentence: string, col: string, p: Params): boolean {
  const ownUnit = p.columns[col]?.unit ?? "";
  if (!ownUnit) return false;
  const valueUnits = new Set<string>();
  for (const [name, r] of Object.entries(p.columns)) {
    if (r.role === "value" && r.unit) valueUnits.add(normUnit(r.unit));
  }
  for (const u of valueUnits) {
    if (u === normUnit(ownUnit)) continue;
    // does the sentence carry a value with this foreign value-column unit?
    if (valuesWithUnit(sentence, u).length > 0) return true;
  }
  return false;
}

function normUnit(u: string): string {
  return u.replace(/°/g, "").toLowerCase();
}

// 1. model-prediction
function checkModelPrediction(
  para: string,
  sentences: string[],
  p: Params,
  boundCols: string[],
  formulaBinds: { col: string; form: FormName }[],
  proseForm: FormName | null,
  out: RecheckClaim[]
): void {
  // A single block-level index ref (the only distinct index named in the whole
  // paragraph) is shared by bullets that each name their own column but omit the
  // index — the latex-derivation dialect states "For batch 47:" once at the top,
  // then one bullet per column. A bullet with its own unambiguous (col, form)
  // binding may borrow this shared index. Only valid when exactly one distinct
  // index ref exists across the paragraph (otherwise pairing is ambiguous).
  const blockKsAll = Array.from(new Set(sentences.flatMap((s) => extractIndexRefs(s, p))));
  const sharedBlockK = blockKsAll.length === 1 ? blockKsAll[0] : null;

  let emitted = false;
  for (const sentence of sentences) {
    // Bind a (col, form) pair. Prefer a binding local to THIS sentence (its own
    // column token + form), so a list paragraph that mentions several columns still
    // binds each bullet to its own column. Fall back to the paragraph binding.
    // Near-token (digit-bearing prefix) binding is admitted at SENTENCE scope only:
    // the latex bullet "Tat20min: ... linear" names the column by a unit-stripped
    // prefix. Kept sentence-local so it never leaks into the paragraph-wide fallback
    // that derivation-step sentences ("total cooling span ... 60.04 min") rely on.
    const exactCols = boundColumnTokens(sentence, p);
    const sentCols = exactCols.length > 0
      ? exactCols
      : Array.from(new Set(nearTokenColumns(sentence, p)));
    const sentForm = formInProse(sentence);
    const sentFormulaBinds = bindByFormula(sentence, p);
    let ks = extractIndexRefs(sentence, p);
    // Borrow the shared block index only when this sentence has its OWN unambiguous
    // local binding (its own formula, or its own single column token + named form)
    // — never for a bare prose sentence relying on the paragraph-wide binding.
    if (ks.length === 0 && sharedBlockK !== null) {
      const ownLocalBind =
        sentFormulaBinds.length === 1 ||
        (sentCols.length === 1 && sentForm !== null && fitOf(p.trends[sentCols[0]], sentForm) !== null);
      if (ownLocalBind) ks = [sharedBlockK];
    }
    if (ks.length === 0) continue;
    const candidates: { col: string; form: FormName }[] = [];
    if (sentFormulaBinds.length > 0) {
      for (const fb of sentFormulaBinds) candidates.push(fb);
    } else if (sentCols.length === 1 && sentForm) {
      if (fitOf(p.trends[sentCols[0]], sentForm)) candidates.push({ col: sentCols[0], form: sentForm });
    } else if (formulaBinds.length > 0) {
      for (const fb of formulaBinds) candidates.push(fb);
    } else {
      const formGuess = proseForm;
      for (const col of boundCols) {
        const form = formGuess ?? p.trends[col]?.best ?? null;
        if (form && fitOf(p.trends[col], form)) candidates.push({ col, form });
      }
    }
    // A two-index difference sentence ("plugging in k=15 and k=95 yields the 6.8 min
    // difference") states |f(K2)−f(K1)|, NOT a point value at either index — recompute
    // it as a model-prediction-DIFFERENCE (or extract nothing if ambiguous) and never
    // fall through to the point-prediction loop, which would flag a true difference.
    if (tryModelDifference(sentence, candidates, p, out)) { emitted = true; continue; }
    // An aggregate-over-range sentence ("arithmetic mean of predictions for k = 1…110:
    // 37.5 min") states the mean of a bound form over the range, NOT a point value at any
    // single index — recompute it as a model-prediction AGGREGATE (or extract nothing if
    // ambiguous) and never fall through to the point-prediction loop.
    if (tryModelAggregate(sentence, candidates, p, out)) { emitted = true; continue; }
    if (candidates.length !== 1) continue; // ambiguous → extract nothing
    const { col, form } = candidates[0];
    const fit = fitOf(p.trends[col], form);
    if (!fit) continue;
    // FIX 1: a sentence naming ≥2 distinct forms with ≥2 same-unit values pairs each value
    // with its nearest preceding form mention (one value per form), instead of binding all
    // to the single `form` chosen for the paragraph. Only with exactly one in-play index;
    // returns false (falls through) unless the sentence genuinely names ≥2 distinct forms.
    if (ks.length === 1 && tryMultiFormPairing(sentence, col, ks[0], p, out)) { emitted = true; continue; }

    // Claimed value must carry the column's unit here (a value asserted AS this
    // column's output) — rejects formula restatements and unit-less intermediates.
    const unit = p.columns[col]?.unit ?? "";
    // FP class A: a per-index list of a derived (non-column) quantity — "the drop is
    // ≈ 4.4 °C (batch 1) and ≈ 4.2 °C (batch 110)" — is NOT a list of point predictions
    // of the bound column. Recomputing within-window drops is out of scope, so extract
    // nothing for this sentence (never flag a true within-batch cooling drop).
    if (isDerivedPerIndexList(sentence, p, unit)) continue;
    const unitVals = valuesWithUnit(sentence, unit);
    if (unitVals.length === 0) continue;

    for (const k of ks) {
      if (!inEnvelope(k, p)) continue;
      const recomputed = evalForm(form, fit.params, k);
      // Choose the unit-carrying value closest to the recomputed value, but only
      // among those that are not the index k, a form param (formula restatement), or
      // an input-marked value ("at 33.7 min" — a clock-time/x-axis input the model maps
      // FROM, never its own output; the column's unit can equal the x-axis unit).
      const cand = unitVals.filter(
        (v) => v.value !== k && !isFormParam(v.value, fit.params) && !isInputMarkedValue(sentence, v.index)
      );
      if (cand.length === 0) continue;
      let best = cand[0];
      let bestErr = Infinity;
      for (const c of cand) {
        const err = Math.abs(c.value - recomputed);
        if (err < bestErr) { bestErr = err; best = c; }
      }
      // Mis-extraction + unit guard: when the best same-unit candidate is implausibly
      // far from the recomputation AND the sentence asserts a value carrying a foreign
      // value-column unit, the (col, form) binding is wrong — the sentence is about the
      // other column (e.g. a "3.55 V" voltage claim mis-bound to a seconds column whose
      // only same-unit hit is the "1000 s" time anchor). Extract nothing, never flag.
      // The unit conflict is required, so same-unit sign-error fabrications keep flagging.
      if (bestErr > MISEXTRACT_WINDOW * Math.abs(recomputed) && assertsForeignValueUnit(sentence, col, p)) continue;
      const tol = Math.max(REL_PREDICTION * Math.abs(recomputed), halfUlp(best.literal));
      const verdict = Math.abs(best.value - recomputed) > tol ? "flag" : "pass";
      pushClaim(out, sentence, `${form}(${k}) = ${round(recomputed)} for ${col}`, verdict, "model-prediction");
      emitted = true;
    }
  }

  // Fallback for derivation layouts that split "At cycle 90:" from the bullet
  // carrying the result: with exactly ONE index ref and ONE (col, form) binding
  // in the whole paragraph, block-level pairing is still unambiguous.
  if (emitted) return;
  const allKs = Array.from(new Set(sentences.flatMap((s) => extractIndexRefs(s, p))));
  if (allKs.length !== 1 || !inEnvelope(allKs[0], p)) return;
  const candidates = formulaBinds.length > 0
    ? formulaBinds
    : boundCols.flatMap((col) => {
        const form = proseForm ?? p.trends[col]?.best ?? null;
        return form && fitOf(p.trends[col], form) ? [{ col, form }] : [];
      });
  const unique = Array.from(new Set(candidates.map((c) => `${c.col} ${c.form}`)));
  if (unique.length !== 1) return;
  const { col, form } = candidates[0];
  const fit = fitOf(p.trends[col], form);
  if (!fit) return;
  const k = allKs[0];
  const recomputed = evalForm(form, fit.params, k);
  const unitVals = valuesWithUnit(para, p.columns[col]?.unit ?? "")
    .filter((v) => v.value !== k && !isFormParam(v.value, fit.params) && !isInputMarkedValue(para, v.index));
  if (unitVals.length === 0) return;
  let best = unitVals[0];
  let bestErr = Infinity;
  for (const c of unitVals) {
    const err = Math.abs(c.value - recomputed);
    if (err < bestErr) { bestErr = err; best = c; }
  }
  // Plausibility window: a block-paired value >25% off the recomputation is a
  // mis-extraction (an aside, not the prediction) — extract nothing rather than
  // flag. Real fabrications (≈2% off) sit between tol and this window. (The unit-conflict
  // case is already covered here: a foreign-unit mis-bind reads as an implausible pair.)
  if (bestErr > MISEXTRACT_WINDOW * Math.abs(recomputed)) return;
  const tol = Math.max(REL_PREDICTION * Math.abs(recomputed), halfUlp(best.literal));
  const verdict = Math.abs(best.value - recomputed) > tol ? "flag" : "pass";
  pushClaim(out, para.replace(/\n+/g, " "), `${form}(${k}) = ${round(recomputed)} for ${col}`, verdict, "model-prediction");
}

// Carried-binding model-prediction: a (col, form) binding established by a formula
// in an earlier paragraph of the same derivation chain propagates to a later
// paragraph that restates the model's predictions in prose ("At cycle 134 C ≈
// 1.4007 Ah; at cycle 135 C ≈ 1.3970 Ah") but carries neither column token nor
// formula of its own. Stricter than the in-paragraph path: each prediction must be
// FORWARD — the index reference precedes the unit-carrying value it predicts, and
// each (index, value) pair is matched left-to-right. This excludes inverse claims
// ("...below 1.40 Ah is cycle 135", value before index) which v1 does not extract.
function checkCarriedPrediction(
  para: string,
  sentences: string[],
  p: Params,
  carried: { col: string; form: FormName },
  out: RecheckClaim[]
): void {
  const { col, form } = carried;
  const fit = fitOf(p.trends[col], form);
  if (!fit) return;
  const unit = p.columns[col]?.unit ?? "";
  if (!unit) return;
  // The paragraph must read as a restatement of the model's OUTPUT, not a narration
  // of observed data ("batch 10 took 33.4 min, which the model corroborates"). Require
  // an explicit prediction cue: a prediction verb (predicts/yields/gives) or the form
  // named in prose. A bare "model" elsewhere in the paragraph is not enough. Without a
  // cue, extract nothing — high precision over recall when prose intent is ambiguous.
  if (!PREDICTION_CUE.test(para) && !formInProse(para)) return;
  for (const sentence of sentences) {
    // A two-index difference restatement ("from batch 15 to 95, a 6.8 min difference")
    // states |f(K2)−f(K1)| of the carried form, not a point value — recompute it as a
    // difference (or stay silent if ambiguous) and skip the forward point-pairing.
    if (tryModelDifference(sentence, [carried], p, out)) continue;
    // An aggregate-over-range restatement states the mean of the carried form over the
    // range, not a point value — recompute it (or stay silent if ambiguous) and skip the
    // forward point-pairing.
    if (tryModelAggregate(sentence, [carried], p, out)) continue;
    // FP class A: a per-index list of a derived (non-column) quantity is not a list of
    // point predictions of the carried column — extract nothing (see isDerivedPerIndexList).
    if (isDerivedPerIndexList(sentence, p, unit)) continue;
    const refs = indexRefsWithPos(sentence, p);
    if (refs.length === 0) continue;
    // FIX 1: a sentence naming ≥2 distinct forms with ≥2 same-unit values states one value
    // per form (the linear value AND the nlogn value side by side). The carried single
    // (col, form) would bind every value to one form and false-flag the other. Pair each
    // value with its nearest preceding form mention instead. Only when exactly one index
    // is in play (otherwise index↔value pairing is itself ambiguous — leave it). Guarded by
    // ≥2 DISTINCT forms so an ordinary single-form restatement falls straight through.
    if (refs.length === 1 && tryMultiFormPairing(sentence, col, refs[0].k, p, out)) continue;
    const vals = valuesWithUnit(sentence, unit).filter(
      (v) => !isFormParam(v.value, fit.params) && !isInputMarkedValue(sentence, v.index)
    );
    if (vals.length === 0) continue;
    // The carried form is unambiguously asserted when this sentence is itself a clean
    // headline prediction: a prediction cue, the carried column's unit-unique noun, the
    // carried column unit-unique for its unit, exactly one index, and exactly one same-
    // unit (non-input) value. Under that triad the value cannot be a foreign-unit mis-
    // bind, an x-axis input, or an aside — it IS this column's output. A sign-error
    // fabrication (≈40% off, beyond the mis-extraction window) must still flag here, so
    // tolerance alone decides (no plausibility window), matching the clause-paired path's
    // doctrine for unambiguous constructions. ("Predicted time ... for batch 95 = 40.86
    // min" — a sign-error answer concludes ≈24.69 min and must flag.)
    const nouns = unitNoun(unit);
    const headlinePrediction =
      PREDICTION_CUE.test(sentence) &&
      unitUniqueColumn(p, unit) === col &&
      nouns.length > 0 &&
      nouns.some((w) => sentence.toLowerCase().includes(w)) &&
      refs.length === 1 &&
      vals.length === 1;
    for (const ref of refs) {
      if (ref.k === undefined || !inEnvelope(ref.k, p)) continue;
      // forward orientation: the predicted value must appear AFTER its index ref,
      // and must not be itself another index ref's number.
      const forward = vals.filter((v) => v.index > ref.index && v.value !== ref.k);
      if (forward.length === 0) continue;
      const recomputed = evalForm(form, fit.params, ref.k);
      // pair to the nearest unit value following the index ref
      const best = forward.reduce((a, b) => (b.index < a.index ? b : a));
      // plausibility window: a paired value far off recomputation is a mis-extraction,
      // not a fabrication — stay silent rather than flag (same doctrine as block path).
      // The unit-conflict case (a foreign-unit value mis-bound to this column) reads as
      // an implausible pair and is suppressed by the same window; same-unit sign-error
      // fabrications stay within it and keep flagging. SKIPPED for a headline prediction
      // (guards above make the value unambiguously this column's output).
      if (!headlinePrediction && Math.abs(best.value - recomputed) > MISEXTRACT_WINDOW * Math.abs(recomputed)) continue;
      const tol = Math.max(REL_PREDICTION * Math.abs(recomputed), halfUlp(best.literal));
      const verdict = Math.abs(best.value - recomputed) > tol ? "flag" : "pass";
      pushClaim(out, sentence, `${form}(${ref.k}) = ${round(recomputed)} for ${col}`, verdict, "model-prediction");
    }
  }
}

// Prose-register (synonym) model-prediction: a sentence that states a model output
// in domain prose with neither a column token nor a quoted formula, e.g. "the linear
// trend predicts a discharge capacity of 1.5081 Ah at cycle 105". Binds the column
// by unit-uniqueness + noun (synonymBoundColumns) and the form by prose. Deliberately
// strict — high precision over recall, since the looser in-paragraph path would mis-
// pair measured/aside values (e.g. U1's "measured capacity ... 1.449 Ah", a slope
// quote, or "0.041 Ah below the prediction"):
//   • exactly ONE synonym-bound column for the sentence (unit-unique),
//   • a named form in the sentence,
//   • a prediction-cue verb (predicts/yields/gives/projects) in the sentence,
//   • exactly ONE index reference in the sentence,
//   • the closest unit-carrying value (excluding the index and form params) must lie
//     within the plausibility window of the recomputation — otherwise stay SILENT
//     (the value is an aside, not the prediction; never flag on a mis-extraction).
// Orientation-agnostic (handles both "at cycle K predicts V" and "predicts V at
// cycle K"): the single-ref + single-column construction is already unambiguous.
function checkSynonymPrediction(
  para: string,
  sentences: string[],
  p: Params,
  boundCols: string[],
  formulaBinds: { col: string; form: FormName }[],
  carried: { col: string; form: FormName } | null,
  out: RecheckClaim[]
): void {
  // Only when the paragraph has no token/formula binding of its own — token and
  // formula paths already own those paragraphs (this is the prose-only fallback).
  if (boundCols.length > 0 || formulaBinds.length > 0) return;
  // And only when no upstream derivation binding is in flight: a paragraph mid-chain
  // (carried set) is owned by the carried-prediction path, which restricts to FORWARD
  // pairs and so correctly excludes inverse claims ("...below 1.40 Ah is cycle 135").
  // Running the orientation-agnostic synonym path there would re-extract the inverse.
  if (carried !== null) return;
  for (const sentence of sentences) {
    if (!PREDICTION_CUE.test(sentence)) continue;
    const synCols = synonymBoundColumns(sentence, p);
    if (synCols.length !== 1) continue; // ambiguous → extract nothing
    const col = synCols[0];
    const form = formInProse(sentence);
    if (!form) continue;
    const fit = fitOf(p.trends[col], form);
    if (!fit) continue;
    const ks = extractIndexRefs(sentence, p);
    if (ks.length !== 1 || !inEnvelope(ks[0], p)) continue;
    const k = ks[0];
    const unit = p.columns[col]?.unit ?? "";
    const cand = valuesWithUnit(sentence, unit).filter(
      (v) => v.value !== k && !isFormParam(v.value, fit.params)
    );
    if (cand.length === 0) continue;
    const recomputed = evalForm(form, fit.params, k);
    let best = cand[0];
    let bestErr = Infinity;
    for (const c of cand) {
      const err = Math.abs(c.value - recomputed);
      if (err < bestErr) { bestErr = err; best = c; }
    }
    // plausibility window: a far-off value is an aside (measured value, slope, error
    // quote), not the prediction — stay silent rather than flag (mis-extraction doctrine).
    if (bestErr > MISEXTRACT_WINDOW * Math.abs(recomputed)) continue;
    const tol = Math.max(REL_PREDICTION * Math.abs(recomputed), halfUlp(best.literal));
    const verdict = Math.abs(best.value - recomputed) > tol ? "flag" : "pass";
    pushClaim(out, sentence, `${form}(${k}) = ${round(recomputed)} for ${col}`, verdict, "model-prediction");
  }
}

// Clause-paired (two-column) model-prediction. A single sentence states predictions
// for TWO trend columns in parallel clauses, each carrying its own named form and
// claimed value+unit, with the index named once in the paragraph rather than in the
// sentence. e.g. "...: for time-to-45 °C the exponential trend gives 41.63 min, and
// for temperature-at-20 min the linear trend gives 60.66 °C." (batch 104 named in the
// prior sentence). The single-column synonym path can't bind this — the sentence
// carries BOTH a °C and a min value, so it is unit-ambiguous as a whole.
//
// Mechanism: split on the clause connectives (", and " / "; " / ": for"); each clause
// binds INDEPENDENTLY when it carries (a) a named form, (b) exactly one claimed value
// — a value+unit (value-column unit) appearing AFTER the named form, so a unit inside
// the column's PROSE NAME ("time-to-45 °C") is never mistaken for the claim — whose
// unit is unit-unique to one trend column, and (c) that unit's canonical noun. The
// index is borrowed from the paragraph when the paragraph names exactly one. The clause
// structure makes the value unambiguously the asserted output, so NO plausibility
// window applies (unlike the looser single-column fallbacks): tolerance alone decides.
// An ambiguous clause extracts nothing; the other clause may still bind.
function checkClausePairedPrediction(
  para: string,
  sentences: string[],
  p: Params,
  boundCols: string[],
  formulaBinds: { col: string; form: FormName }[],
  out: RecheckClaim[]
): void {
  // Prose-only register: token/formula paths already own those paragraphs.
  if (boundCols.length > 0 || formulaBinds.length > 0) return;
  // Paragraph-level index borrow: exactly one index named across the whole paragraph.
  const paraKs = Array.from(new Set(sentences.flatMap((s) => extractIndexRefs(s, p))));
  if (paraKs.length !== 1 || !inEnvelope(paraKs[0], p)) return;
  const k = paraKs[0];

  for (const sentence of sentences) {
    // Only sentences that split into ≥2 clauses on the paired connectives.
    const clauses = sentence.split(/,\s+and\s+|;\s+|:\s+(?=for\b)/i);
    if (clauses.length < 2) continue;
    const bound: { col: string; form: FormName; value: number; literal: string }[] = [];
    let ambiguous = false;
    for (const rawClause of clauses) {
      const clause = rawClause.trim();
      const form = formInProse(clause);
      if (!form) continue; // a clause without its own named form is not a paired prediction
      // The claimed value is the value+unit (with a value-column unit) appearing AFTER
      // the named form — never a unit inside the column's prose name ("time-to-45 °C").
      const formIdx = clauseFormIndex(clause);
      const claimed = clauseClaimedValue(clause, formIdx, p);
      if (claimed === null) { continue; }
      const col = unitUniqueColumn(p, claimed.unit);
      if (!col) { ambiguous = true; continue; } // unit not unit-unique → ambiguous clause
      if (!fitOf(p.trends[col], form)) { ambiguous = true; continue; }
      // condition (c): the unit's canonical noun is present in the clause.
      const nouns = unitNoun(claimed.unit);
      if (nouns.length === 0 || !nouns.some((w) => clause.toLowerCase().includes(w))) continue;
      bound.push({ col, form, value: claimed.value, literal: claimed.literal });
    }
    if (ambiguous) continue; // any ambiguous clause → the sentence is unsafe; skip it
    // Require the clauses to bind DISTINCT columns — a genuine two-column parallel
    // statement. A single bound clause is left to the single-column synonym path.
    const cols = new Set(bound.map((b) => b.col));
    if (bound.length < 2 || cols.size !== bound.length) continue;
    for (const b of bound) {
      const fit = fitOf(p.trends[b.col], b.form);
      if (!fit) continue;
      const recomputed = evalForm(b.form, fit.params, k);
      const tol = Math.max(REL_PREDICTION * Math.abs(recomputed), halfUlp(b.literal));
      const verdict = Math.abs(b.value - recomputed) > tol ? "flag" : "pass";
      pushClaim(out, sentence, `${b.form}(${k}) = ${round(recomputed)} for ${b.col}`, verdict, "model-prediction");
    }
  }
}

// Position of the named form in a clause (the form word the claimed value follows).
function clauseFormIndex(clause: string): number {
  const m = clause.match(/\b(?:sqrt[-\s_]?linear|square[-\s]?root|exponential|linear)\b/i);
  return m && m.index !== undefined ? m.index : 0;
}

// The single claimed value+unit in a clause: a value carrying a VALUE-column unit that
// appears AFTER the named form (position ≥ formIdx). Returns null when zero or more than
// one such value exists (ambiguous — the caller treats that clause conservatively).
function clauseClaimedValue(
  clause: string,
  formIdx: number,
  p: Params
): { value: number; unit: string; literal: string } | null {
  const valUnits = new Set(
    valueColumns(p).map((c) => normUnit(p.columns[c]?.unit ?? "")).filter((u) => u !== "")
  );
  const re = /(-?\d+(?:\.\d+)?)\s*°?\s*(Ah|mAh|mV|V|min|s|°C|C)\b/gi;
  const hits: { value: number; unit: string; literal: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause)) !== null) {
    if (m.index < formIdx) continue; // a unit inside the prose name precedes the form
    const unit = m[2];
    if (!valUnits.has(normUnit(unit))) continue;
    hits.push({ value: Number(m[1]), unit, literal: m[1] });
  }
  return hits.length === 1 ? hits[0] : null;
}

function round(v: number): string {
  if (Math.abs(v) >= 100) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(3);
  return v.toPrecision(4);
}

// 2. constant-quote (MAE / params / envelope bounds quoted against a bound column+field)
function checkConstantQuote(
  para: string,
  sentences: string[],
  p: Params,
  boundCols: string[],
  formulaBinds: { col: string; form: FormName }[],
  proseForm: FormName | null,
  out: RecheckClaim[]
): void {
  for (const sentence of sentences) {
    // The literal must be tightly bound to the word "MAE" (the only field this case
    // checks): "MAE of ±0.0322 Ah", "MAE ~56 s", "MAE 0.032", "MAE = 0.294 min", or
    // "<num> <unit> MAE". Loose "validation"/"held-out" alone is not enough — those
    // words also appear in "best held-out validation model" with no quoted constant.
    const m = sentence.match(/\bMAE\b\s*(?:of|is|=|≈|:|±|~)*\s*±?\s*(\d+(?:\.\d+)?)\s*(mAh|mV|Ah|V|min|s|°C|C)?/i)
      ?? sentence.match(/(\d+(?:\.\d+)?)\s*(mAh|mV|Ah|V|min|s|°C|C)?\s*\bMAE\b/i);
    if (!m) continue;
    // A Δ/delta/change/drop-marked quantity is a derived difference, NOT a stored
    // constant — it must never be a constant-quote candidate (a "fitting MAE" is itself
    // never delta-marked, so this only suppresses true difference quotes).
    if (isDeltaMarked(sentence, m.index ?? 0)) continue;
    // Column binding: prefer a token in the paragraph; otherwise allow prose-register
    // (synonym) binding — a unit-unique column whose noun appears in THIS sentence —
    // so an MAE quoted in domain prose ("the linear capacity trend ... validation MAE
    // 0.0322 Ah") binds without a token. Must resolve to exactly one column either way.
    let col: string;
    if (boundCols.length === 1) {
      col = boundCols[0];
    } else if (boundCols.length === 0) {
      const synCols = synonymBoundColumns(sentence, p);
      if (synCols.length !== 1) continue;
      col = synCols[0];
    } else {
      continue; // multiple token columns → ambiguous
    }
    const trend = p.trends[col];
    if (!trend) continue;
    const form = proseForm
      ?? formInProse(sentence)
      ?? (formulaBinds.find((f) => f.col === col)?.form)
      ?? null;
    if (!form) continue;
    const fit = fitOf(trend, form);
    if (!fit) continue;
    // MAEs are stored in the column's base unit (V, Ah). An answer may quote them in
    // the milli unit ("4 mV", "6.6 mV"); scale the claim to the base before comparing,
    // and shrink halfUlp by the same factor so its last-significant-digit meaning holds.
    const claimUnit = (m[2] ?? "").toLowerCase();
    const colUnit = (p.columns[col]?.unit ?? "").toLowerCase();
    const milli =
      (claimUnit === "mv" && colUnit === "v") || (claimUnit === "mah" && colUnit === "ah")
        ? 0.001
        : 1;
    const claimed = Number(m[1]) * milli;
    const ulp = halfUlp(m[1]) * milli;
    const stored = [fit.val_mae, fit.fit_mae];
    const ok = stored.some((s) => Math.abs(Math.abs(claimed) - Math.abs(s)) <= Math.max(REL_CONSTANT * Math.abs(s), ulp));
    pushClaim(
      out,
      sentence,
      `${col} ${form} val_mae=${round(fit.val_mae)}, fit_mae=${round(fit.fit_mae)}`,
      ok ? "pass" : "flag",
      "constant-quote"
    );
  }
}

// Relative window for grounding a claimed quantity against a pack value/difference:
// the larger of 1% of the pack value or half-ulp of the claimed literal. Tighter than
// the ±3pp ratio tolerance, which stays frozen and governs the percentage comparison.
const GROUND_REL = 0.01;

// A growth/decline percentage between two same-unit quantities cited at two indices.
// Grounds each quantity at its index as a value-column value OR a same-unit difference
// of two value columns, then compares the pack-grounded growth ratio to the claim. If
// either quantity cannot be grounded → emit nothing (mis-extraction, never flag).
// Returns true iff this sentence is a two-quantity/two-index growth construction (so
// the caller's single-column derived-ratio path skips it).
function tryDiffRatio(
  sentence: string,
  pct: number,
  p: Params,
  ds: Dataset,
  idxCol: string | null,
  out: RecheckClaim[]
): boolean {
  // Growth/decline cue + "from ... to" construction required.
  if (!/\b(grows?|grew|increases?|increased|rises?|rose|climbs?|falls?|fell|declines?|declined|decreases?|decreased|drops?|dropped)\b/i.test(sentence)) {
    return false;
  }
  // exactly two distinct index references, in order of appearance (K1 → K2)
  const refs = indexRefsWithPos(sentence, p);
  if (refs.length !== 2 || refs[0].k === refs[1].k) return false;
  const ordered = [...refs].sort((a, b) => a.index - b.index);
  const k1 = ordered[0].k;
  const k2 = ordered[1].k;

  // same-unit quantity pair: collect quantities with a value-column unit, in order,
  // and find a unit that has exactly two distinct quantities.
  const quantities: { value: number; unit: string; literal: string; index: number }[] = [];
  const unitRe = /(\d+(?:\.\d+)?)\s*(Ah|mAh|V|mV|min|s|°C|C)\b/gi;
  let qm: RegExpExecArray | null;
  while ((qm = unitRe.exec(sentence)) !== null) {
    quantities.push({ value: Number(qm[1]), unit: qm[2], literal: qm[1], index: qm.index });
  }
  const valCols = valueColumns(p);
  const byUnit = new Map<string, typeof quantities>();
  for (const q of quantities) {
    const matchesValueCol = valCols.some((c) => unitMatch(p.columns[c]?.unit ?? "", q.unit));
    if (!matchesValueCol) continue;
    const key = normUnit(q.unit);
    const arr = byUnit.get(key) ?? [];
    arr.push(q);
    byUnit.set(key, arr);
  }
  const pairs: { x1: typeof quantities[number]; x2: typeof quantities[number] }[] = [];
  for (const arr of byUnit.values()) {
    const distinct = arr.filter((q, i) => arr.findIndex((o) => o.value === q.value) === i);
    if (distinct.length === 2) {
      const sorted = [...arr].sort((a, b) => a.index - b.index);
      pairs.push({ x1: sorted[0], x2: sorted[sorted.length - 1] });
    }
  }
  if (pairs.length === 0) return false;

  // This IS a growth construction; from here we own the sentence (so the single-column
  // path never double-flags the same quantities). Some same-unit pairs are positional
  // noise (e.g. the "1000 s"/"1800 s" time labels inside "v(1000 s)"); the subject pair
  // is the one that grounds at both indices. Emit for the first fully-grounded pair; if
  // none grounds, stay silent (mis-extraction).
  for (const pair of pairs) {
    const g1 = groundQuantity(pair.x1, k1, p, ds, idxCol);
    const g2 = groundQuantity(pair.x2, k2, p, ds, idxCol);
    if (g1 === null || g2 === null || g1 === 0 || g2 === 0) continue;
    const cands = [((g2 - g1) / g1) * 100, ((g1 - g2) / g2) * 100];
    const detail = `grounded ${round(g1)}@${k1} → ${round(g2)}@${k2}: ${round(cands[0])}% / ${round(cands[1])}%`;
    if (cands.some((c) => Math.abs(c - pct) <= RATIO_TOL_PP)) {
      pushClaim(out, sentence, `${detail} matches ${pct}%`, "pass", "derived-ratio");
    } else {
      pushClaim(out, sentence, `${detail} vs claimed ${pct}%`, "flag", "derived-ratio");
    }
    return true;
  }
  return true; // owned the sentence but no pair grounded → silent
}

// Ground a claimed quantity at an index against the pack: returns the pack value if the
// claim matches a value-column value OR a same-unit |difference| of two value columns at
// that index (within GROUND_REL or half-ulp). null if nothing within window grounds it.
function groundQuantity(
  q: { value: number; unit: string; literal: string },
  k: number,
  p: Params,
  ds: Dataset,
  idxCol: string | null
): number | null {
  const tol = Math.max(GROUND_REL * Math.abs(q.value), halfUlp(q.literal));
  const sameUnitCols = valueColumns(p).filter((c) => unitMatch(p.columns[c]?.unit ?? "", q.unit));
  const vals = new Map<string, number>();
  for (const c of sameUnitCols) {
    const v = datasetValueAt(ds, idxCol, c, k) ?? predictBest(p, c, k);
    if (v !== null) vals.set(c, v);
  }
  // direct value-column value
  for (const v of vals.values()) {
    if (Math.abs(Math.abs(q.value) - Math.abs(v)) <= tol) return v;
  }
  // same-unit difference of two value columns
  const cols = [...vals.keys()];
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const diff = Math.abs(vals.get(cols[i])! - vals.get(cols[j])!);
      if (Math.abs(q.value - diff) <= tol) return diff;
    }
  }
  return null;
}

// 3. derived-ratio (percentage from a quantity + dataset value at a cited index)
function checkDerivedRatio(
  para: string,
  sentences: string[],
  p: Params,
  ds: Dataset,
  out: RecheckClaim[]
): void {
  const valCols = valueColumns(p);
  const idxCol = indexColumn(p);
  for (const sentence of sentences) {
    // Span-fraction sentences are handled by checkSpanFraction; skip them here so a
    // stray unit-matched quantity (e.g. "48 °C") doesn't double-flag.
    if (/%\s+of\b[^.;]*\bspan\b/i.test(sentence)) continue;
    const pctMatch = sentence.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!pctMatch) continue;
    const pct = Number(pctMatch[1]);
    // Cross-index growth/decline of a quantity ("X1 (cycle K1) → X2 (cycle K2),
    // grows by Y%"): two same-unit quantities at two indices, each grounded against
    // the pack as a value-column value or a same-unit DIFFERENCE of two value cols.
    // Owns the sentence whether it emits or stays silent (mis-extraction), so the
    // single-column path below never double-flags it.
    if (tryDiffRatio(sentence, pct, p, ds, idxCol, out)) continue;
    const ks = extractIndexRefs(sentence, p);
    if (ks.length === 0) continue;
    // Quantity X with a unit matching a value column.
    const quantities: { value: number; unit: string }[] = [];
    const unitRe = /(\d+(?:\.\d+)?)\s*(Ah|mAh|V|mV|min|s|°C|C)\b/gi;
    let qm: RegExpExecArray | null;
    while ((qm = unitRe.exec(sentence)) !== null) {
      quantities.push({ value: Number(qm[1]), unit: qm[2] });
    }
    if (quantities.length === 0) continue;

    for (const k of ks) {
      // candidates = {X/v, 1−X/v} for every value col whose unit matches a quantity's
      let anyPass = false;
      let detail = "";
      for (const q of quantities) {
        for (const vcol of valCols) {
          const unit = p.columns[vcol]?.unit ?? "";
          if (!unitMatch(unit, q.unit)) continue;
          const v = datasetValueAt(ds, idxCol, vcol, k) ?? predictBest(p, vcol, k);
          if (v === null || v === 0) continue;
          const cands = [q.value / v, 1 - q.value / v].map((r) => r * 100);
          if (cands.some((c) => Math.abs(c - pct) <= RATIO_TOL_PP)) anyPass = true;
          detail = `${vcol}@${k}=${round(v)}: X/v=${round((q.value / v) * 100)}%, 1-X/v=${round((1 - q.value / v) * 100)}%`;
        }
      }
      if (!detail) continue;
      if (anyPass) {
        pushClaim(out, sentence, `${detail} matches ${pct}%`, "pass", "derived-ratio");
      } else {
        pushClaim(out, sentence, `cycle ${k}: ${detail} vs claimed ${pct}%`, "flag", "derived-ratio");
      }
    }
  }
}

function unitMatch(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/°/g, "").toLowerCase();
  return norm(a) === norm(b);
}

function datasetValueAt(ds: Dataset, idxCol: string | null, vcol: string, k: number): number | null {
  if (!idxCol) return null;
  const ki = ds.header.indexOf(idxCol);
  const vi = ds.header.indexOf(vcol);
  if (ki < 0 || vi < 0) return null;
  for (const r of ds.rows) {
    if (r[ki] === k) return r[vi];
  }
  return null;
}

function predictBest(p: Params, vcol: string, k: number): number | null {
  const trend = p.trends[vcol];
  if (!trend?.best) return null;
  const fit = fitOf(trend, trend.best);
  if (!fit) return null;
  return evalForm(trend.best, fit.params, k);
}

// 4. trend-direction
function checkTrendDirection(
  para: string,
  sentences: string[],
  p: Params,
  ds: Dataset,
  boundCols: string[],
  formulaBinds: { col: string; form: FormName }[],
  proseForm: FormName | null,
  out: RecheckClaim[]
): void {
  // Need an unambiguous column binding for the paragraph. A single quoted formula
  // pins the column even when several value tokens are mentioned in passing.
  const fbCols = Array.from(new Set(formulaBinds.map((f) => f.col)));
  const cols = fbCols.length === 1 ? fbCols : (boundCols.length > 0 ? boundCols : fbCols);
  const uniqueCols = Array.from(new Set(cols));
  if (uniqueCols.length !== 1) return;
  const col = uniqueCols[0];
  const trend = p.trends[col];
  if (!trend || !p.index) return;
  const form = formulaBinds.find((f) => f.col === col)?.form ?? proseForm ?? trend.best;
  if (!form) return;
  const fit = fitOf(trend, form);

  const qWords = quantityWords(col, p.columns[col]?.unit ?? "");
  let modelEmitted = false;
  let dataEmitted = false;

  for (const sentence of sentences) {
    const refsModel = /\bsqrt\b|√|\bk term\b|\bmodel\b|\bfitted\b|\btrend\b|\bform\b|\bterm\b/i.test(sentence);
    const refsData = /\bobserved\b|\bmeasured\b|\bdata show\b|\bpattern of\b|\bdata\b/i.test(sentence);

    if (refsModel && fit && !modelEmitted) {
      // model claim: the form/term direction. Bind sign to the column's quantity.
      const claimedSign = claimedEarlySign(sentence, qWords);
      if (claimedSign !== 0) {
        const sign = earlyModelSign(form, fit.params, p.index);
        if (sign !== 0 && sign !== claimedSign) {
          pushClaim(out, sentence, `${col} ${form} ${sign > 0 ? "RISES" : "FALLS"} initially (early slope sign ${sign > 0 ? "+" : "-"}), claimed ${claimedSign > 0 ? "rise" : "decay"}`, "flag", "trend-direction");
          modelEmitted = true;
        } else if (sign !== 0) {
          pushClaim(out, sentence, `${col} ${form} early sign ${sign > 0 ? "rise" : "decay"} matches`, "pass", "trend-direction");
          modelEmitted = true;
        }
      }
    }
    if (refsData && !dataEmitted) {
      const claimedSign = claimedEarlySign(sentence, qWords);
      if (claimedSign !== 0) {
        const sign = earlyDataSign(ds, p, col);
        if (sign !== 0 && sign !== claimedSign) {
          pushClaim(out, sentence, `${col} measured ${sign > 0 ? "RISES" : "FALLS"} to ~15% point, claimed ${claimedSign > 0 ? "rise" : "decay"}`, "flag", "trend-direction");
          dataEmitted = true;
        } else if (sign !== 0) {
          pushClaim(out, sentence, `${col} measured early sign ${sign > 0 ? "rise" : "decay"} matches`, "pass", "trend-direction");
          dataEmitted = true;
        }
      }
    }
  }
}

// Quantity nouns associated with a column (for binding a directional phrase to the
// column's measured quantity rather than an aside about a different quantity).
function quantityWords(col: string, unit: string): string[] {
  const words: string[] = [];
  if (/^v|volt/i.test(col) || /^m?V$/i.test(unit)) words.push("voltage", "loaded");
  if (/cap/i.test(col)) words.push("capacity", "charge");
  if (/temp|^T/i.test(col) || /°?C/i.test(unit)) words.push("temperature");
  if (/cutoff|duration|time|min|^t_/i.test(col) || /^(s|min)$/i.test(unit)) words.push("time", "duration");
  return words;
}

// Among early-direction phrases in the sentence (verb + qualifier in either order),
// return the sign of the phrase nearest to one of the quantity words. If no quantity
// word is present, fall back to the first phrase found. 0 if none.
const VERB_NEG = /\b(decays?|drops?|falls?|declines?|decreases?|sags?)\b/gi;
const VERB_POS = /\b(rises?|increases?|grows?|climbs?)\b/gi;
const QUALIFIER = /\b(at first|initially|quickly at first|fast initial|quickly|first)\b/i;

function claimedEarlySign(sentence: string, qWords: string[]): number {
  if (!QUALIFIER.test(sentence)) return 0;
  const phrases: { sign: number; index: number }[] = [];
  let m: RegExpExecArray | null;
  VERB_NEG.lastIndex = 0;
  while ((m = VERB_NEG.exec(sentence)) !== null) phrases.push({ sign: -1, index: m.index });
  VERB_POS.lastIndex = 0;
  while ((m = VERB_POS.exec(sentence)) !== null) phrases.push({ sign: 1, index: m.index });
  if (phrases.length === 0) return 0;
  // require a qualifier near (within ~60 chars of) the verb for it to be an EARLY claim
  const qual = sentence.match(QUALIFIER);
  const qualIdx = qual && qual.index !== undefined ? qual.index : -1;
  const early = phrases.filter((ph) => qualIdx >= 0 && Math.abs(ph.index - qualIdx) <= 60);
  const pool = early.length > 0 ? early : phrases;
  if (qWords.length > 0) {
    let qPos = -1;
    for (const w of qWords) {
      const i = sentence.toLowerCase().indexOf(w.toLowerCase());
      if (i >= 0) { qPos = i; break; }
    }
    if (qPos >= 0) {
      let best = pool[0];
      let bestD = Infinity;
      for (const ph of pool) {
        const d = Math.abs(ph.index - qPos);
        if (d < bestD) { bestD = d; best = ph; }
      }
      return best.sign;
    }
  }
  return pool[0].sign;
}

// Initial direction of the fitted form: sign of its slope right at index.min, which
// is what an "at first / quickly at first" claim refers to. A √k term can dominate
// the start (rise) and reverse later (decline) — the initial sign captures the claim.
// Returns 0 only when the form is flat at the start.
function earlyModelSign(form: FormName, params: number[], index: { min: number; max: number }): number {
  const lo = index.min;
  const step = Math.max((index.max - index.min) * 1e-4, 1e-6);
  const d = evalForm(form, params, lo + step) - evalForm(form, params, lo);
  if (d > SIGN_EPS) return 1;
  if (d < -SIGN_EPS) return -1;
  return 0;
}

// early trend of measured column: + means value rises from first 3 points to 15% point.
function earlyDataSign(ds: Dataset, p: Params, col: string): number {
  const idxCol = indexColumn(p);
  if (!idxCol || !p.index) return 0;
  const ki = ds.header.indexOf(idxCol);
  const vi = ds.header.indexOf(col);
  if (ki < 0 || vi < 0) return 0;
  const sorted = [...ds.rows].sort((a, b) => a[ki] - b[ki]);
  if (sorted.length < 4) return 0;
  const first3 = sorted.slice(0, 3).map((r) => r[vi]);
  const meanFirst = first3.reduce((s, v) => s + v, 0) / first3.length;
  const kTarget = p.index.min + 0.15 * (p.index.max - p.index.min);
  // closest row to the 15% envelope point
  let closest = sorted[0];
  let bestD = Infinity;
  for (const r of sorted) {
    const d = Math.abs(r[ki] - kTarget);
    if (d < bestD) { bestD = d; closest = r; }
  }
  const diff = closest[vi] - meanFirst;
  if (Math.abs(diff) <= SIGN_EPS) return 0;
  return diff > 0 ? 1 : -1;
}

// Markers of a hypothetical / conditional / question-restatement. A protocol-current
// sentence carrying any of these is a scenario, not an assertion about the recorded
// protocol — never extract a notes-constant claim from it.
const HYPOTHETICAL = /\b(if|suppose|what happens|asks what|would|instead of|instead|changing to|switching to|scenario|hypothetical)\b/i;

// 5. notes-constant + thermal span fraction
function checkNotesConstant(
  sentences: string[],
  p: Params,
  ds: Dataset,
  notes: string,
  out: RecheckClaim[]
): void {
  const normNotes = normalize(notes);
  const chargeM = normNotes.match(/charge[^.;]*?(\d+(?:\.\d+)?)\s*A\b/i);
  const dischargeM = normNotes.match(/discharge[^.;]*?(\d+(?:\.\d+)?)\s*A\b/i);
  const notesCharge = chargeM ? Number(chargeM[1]) : null;
  const notesDischarge = dischargeM ? Number(dischargeM[1]) : null;

  const rePair = /\b(?:was|were|is|been|cell)\s+(?:charged|cycled|discharged)\b[^.;]*?\bat\s+(\d+(?:\.\d+)?)\s*A(?:\s*\/\s*(\d+(?:\.\d+)?)\s*A)?/i;
  const reCharge = /\bcharged?\s+at\s+(\d+(?:\.\d+)?)\s*A\b/i;

  for (const sentence of sentences) {
    // Reject hypothetical / conditional / question-restatement sentences: a current
    // named inside a "what if X were 4 A instead" clause is not an assertion about the
    // protocol. The assertive-statement regex can otherwise catch the current when the
    // hypothetical marker sits earlier in the sentence. Spec: hypotheticals must NOT
    // match. "instead" included but absent from the assertive U3 offense ("cycled
    // exclusively at 2 A/2 A"), so true protocol mismatches keep flagging.
    if (HYPOTHETICAL.test(sentence)) continue;
    if (notesCharge !== null || notesDischarge !== null) {
      const pm = sentence.match(rePair);
      if (pm) {
        const claimedCharge = Number(pm[1]);
        const claimedDischarge = pm[2] !== undefined ? Number(pm[2]) : null;
        const mismatches: string[] = [];
        if (claimedDischarge !== null) {
          // "X A/Y A": charge=X, discharge=Y
          if (notesCharge !== null && rel(claimedCharge, notesCharge) > NOTES_REL) mismatches.push(`charge ${notesCharge} A (claimed ${claimedCharge} A)`);
          if (notesDischarge !== null && rel(claimedDischarge, notesDischarge) > NOTES_REL) mismatches.push(`discharge ${notesDischarge} A (claimed ${claimedDischarge} A)`);
        } else {
          // single current asserted via cycled/charged/discharged: bind to the verb.
          // Test "discharged" first — it contains the substring "charged", so a charge
          // check would otherwise misclassify a discharge statement.
          const verb = /discharged/i.test(pm[0]) ? "discharge" : /charged/i.test(pm[0]) ? "charge" : "both";
          if (verb === "charge" && notesCharge !== null && rel(claimedCharge, notesCharge) > NOTES_REL) mismatches.push(`charge ${notesCharge} A (claimed ${claimedCharge} A)`);
          else if (verb === "discharge" && notesDischarge !== null && rel(claimedCharge, notesDischarge) > NOTES_REL) mismatches.push(`discharge ${notesDischarge} A (claimed ${claimedCharge} A)`);
          // "cycled at X A" (no pair, no /Y) asserts both legs equal X
          else if (verb === "both") {
            if (notesCharge !== null && rel(claimedCharge, notesCharge) > NOTES_REL) mismatches.push(`charge ${notesCharge} A (claimed ${claimedCharge} A)`);
          }
        }
        if (mismatches.length > 0) {
          pushClaim(out, sentence, `notes: ${mismatches.join("; ")}`, "flag", "notes-constant");
          continue;
        } else {
          pushClaim(out, sentence, `notes currents match`, "pass", "notes-constant");
          continue;
        }
      }
      const cm = sentence.match(reCharge);
      if (cm && notesCharge !== null) {
        const claimed = Number(cm[1]);
        if (rel(claimed, notesCharge) > NOTES_REL) {
          pushClaim(out, sentence, `notes: charge ${notesCharge} A (claimed ${claimed} A)`, "flag", "notes-constant");
        } else {
          pushClaim(out, sentence, `notes charge matches`, "pass", "notes-constant");
        }
      }
    }
  }

  checkSpanFraction(sentences, p, ds, out);
}

function checkSpanFraction(sentences: string[], p: Params, ds: Dataset, out: RecheckClaim[]): void {
  if (!p.shapeCols) return;
  const [gcol, xcol] = p.shapeCols;
  for (const sentence of sentences) {
    // "<num> min ... <num>% of ... span" with batch N named in the same sentence
    if (!/span/i.test(sentence)) continue;
    const pctM = sentence.match(/(\d+(?:\.\d+)?)\s*%\s+of/i);
    const tM = sentence.match(/(\d+(?:\.\d+)?)\s*min\b/i);
    if (!pctM || !tM) continue;
    const groupM = sentence.match(new RegExp(`\\b(?:batch|${escapeRe(gcol)})\\s*(\\d+)`, "i"));
    if (!groupM) continue;
    const pct = Number(pctM[1]);
    const t = Number(tM[1]);
    const g = Number(groupM[1]);
    const gi = ds.header.indexOf(gcol);
    const xi = ds.header.indexOf(xcol);
    if (gi < 0 || xi < 0) continue;
    const xs = ds.rows.filter((r) => r[gi] === g).map((r) => r[xi]);
    if (xs.length < 2) continue;
    const xmin = Math.min(...xs);
    const xmax = Math.max(...xs);
    if (xmax === xmin) continue;
    const frac = ((t - xmin) / (xmax - xmin)) * 100;
    const verdict = Math.abs(frac - pct) > RATIO_TOL_PP ? "flag" : "pass";
    pushClaim(out, sentence, `batch ${g} span fraction = ${round(frac)}% (claimed ${pct}%)`, verdict, "derived-ratio");
  }
}

function rel(a: number, b: number): number {
  if (b === 0) return a === 0 ? 0 : Infinity;
  return Math.abs(a - b) / Math.abs(b);
}

// How many preceding sentences a ratio/percentage sentence may reach back into to
// find the "index ... value unit" statements that ground its X / Y operands.
const RATIO_WINDOW_LINES = 4;

// Derived-ratio WINDOW join. A multi-line ratio derivation states the two operands
// with their index and unit on earlier lines ("Cycle 1 discharge capacity: 1.8565
// Ah ... Cycle 100 ... 1.4859 Ah"), then a later line gives the bare ratio and the
// percentage ("1.4859 / 1.8565 ≈ 0.8004, or 80.0 %") with no unit and no index of
// its own. The single-sentence derived-ratio path can't ground that percentage —
// its X / Y are unitless and indexless. This pass joins the percentage to grounding
// statements in the preceding RATIO_WINDOW_LINES sentences: it grounds each operand
// against the dataset value at its stated index (GROUND_REL), then compares the
// grounded ratio to the claimed percentage (RATIO_TOL_PP). Ungroundable → silent.
//
// Operates on the flattened, in-order sentence list (the construction routinely
// spans paragraph breaks). Only fires when a sentence carries BOTH a percentage and
// an explicit "X / Y" (or "X ÷ Y") quotient of two bare numbers — the ratio
// construction is required so plain percentages never trigger it. To avoid double-
// counting, a sentence already owned by the single-sentence derived-ratio path
// (it carries a unit-bearing quantity + index of its own) is left to that path.
function checkRatioWindow(
  allSentences: string[],
  p: Params,
  ds: Dataset,
  out: RecheckClaim[]
): void {
  const idxCol = indexColumn(p);
  if (!idxCol) return;
  const valCols = valueColumns(p);
  if (valCols.length === 0) return;
  const ratioRe = /(\d+(?:\.\d+)?)\s*[/÷]\s*(\d+(?:\.\d+)?)/;

  for (let i = 0; i < allSentences.length; i++) {
    const sentence = allSentences[i];
    const pctMatch = sentence.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!pctMatch) continue;
    // The ratio construction may sit in this sentence or in the immediately
    // preceding ones (some answers split "fraction is" / "X ÷ Y" / "so 80 %").
    let ratioM: RegExpMatchArray | null = null;
    let ratioIdx = i;
    for (let j = i; j >= Math.max(0, i - RATIO_WINDOW_LINES); j--) {
      const m = allSentences[j].match(ratioRe);
      if (m) { ratioM = m; ratioIdx = j; break; }
    }
    if (!ratioM) continue;
    const X = Number(ratioM[1]);
    const Y = Number(ratioM[2]);
    if (!Number.isFinite(X) || !Number.isFinite(Y) || Y === 0) continue;

    // Skip when THIS sentence already carries a unit-bearing quantity + its own
    // index — the single-sentence derived-ratio path owns it (no double count).
    const hasOwnUnitQty = /(\d+(?:\.\d+)?)\s*(Ah|mAh|V|mV|min|s|°C|C)\b/i.test(sentence);
    if (hasOwnUnitQty && extractIndexRefs(sentence, p).length > 0) continue;

    // Collect "index k ... value unit" grounding statements from the window
    // (the percentage/ratio sentences plus the preceding lines).
    const lo = Math.min(i, ratioIdx);
    const grounds: { k: number; value: number; unit: string; literal: string }[] = [];
    for (let j = Math.max(0, lo - RATIO_WINDOW_LINES); j <= i; j++) {
      const ks = extractIndexRefs(allSentences[j], p);
      if (ks.length !== 1) continue; // need an unambiguous single index per line
      for (const vcol of valCols) {
        const unit = p.columns[vcol]?.unit ?? "";
        for (const v of valuesWithUnit(allSentences[j], unit)) {
          grounds.push({ k: ks[0], value: v.value, unit, literal: v.literal });
        }
      }
    }
    if (grounds.length === 0) continue;

    // Ground X and Y: each must match a grounding statement's value AND that value
    // must match the dataset at the statement's index (GROUND_REL). Ungroundable → silent.
    const groundOperand = (x: number): number | null => {
      for (const g of grounds) {
        const tol = Math.max(GROUND_REL * Math.abs(g.value), halfUlp(g.literal));
        if (Math.abs(x - g.value) > tol) continue;
        const dsVal = datasetValueAt(ds, idxCol, columnForUnit(p, g.unit, valCols), g.k);
        if (dsVal === null) continue;
        if (Math.abs(g.value - dsVal) <= Math.max(GROUND_REL * Math.abs(dsVal), halfUlp(g.literal))) return dsVal;
      }
      return null;
    };
    const gx = groundOperand(X);
    const gy = groundOperand(Y);
    if (gx === null || gy === null || gy === 0) continue;

    const pct = Number(pctMatch[1]);
    const cands = [(gx / gy) * 100, (gy / gx) * 100];
    const detail = `grounded ${round(gx)} / ${round(gy)}: ${round(cands[0])}% / ${round(cands[1])}%`;
    if (cands.some((c) => Math.abs(c - pct) <= RATIO_TOL_PP)) {
      pushClaim(out, sentence, `${detail} matches ${pct}%`, "pass", "derived-ratio");
    } else {
      pushClaim(out, sentence, `${detail} vs claimed ${pct}%`, "flag", "derived-ratio");
    }
  }
}

// The single value column carrying `unit` among `valCols` (first match). Used to
// resolve a grounding statement's unit back to its dataset column for lookup.
function columnForUnit(p: Params, unit: string, valCols: string[]): string {
  for (const c of valCols) {
    if (unitMatch(p.columns[c]?.unit ?? "", unit)) return c;
  }
  return valCols[0];
}

// 6. final-estimate. Eval consults end with a structural summary line — exactly
// "FINAL ESTIMATE: 93606 comparisons". As a structural break it binds nothing during
// the per-paragraph passes, yet it is the "confident single sentence" where the
// sign-error / wrong-form fabrication class lives (gate-calibration finding). This
// pass runs ONCE over the whole answer and binds the line ONLY when every binding
// dimension is unambiguous (high-precision doctrine — never guess):
//   (1) exactly ONE trend column is bound anywhere (token, near-token, or formula),
//   (2) exactly ONE distinct in-envelope index k appears anywhere,
//   (3) the line's unit matches that column's unit,
//   (4) a form is determinable: the prose-named form, else the column's stored best.
// If any condition fails, extract NOTHING. Flagging a FINAL ESTIMATE that contradicts
// the answer's own named form is correct behavior.
function checkFinalEstimate(
  normalized: string,
  paras: string[],
  p: Params,
  out: RecheckClaim[]
): void {
  // LAST FINAL ESTIMATE line. Multiline + case-insensitive; scan all, keep the last.
  const lineRe = /^FINAL ESTIMATE:\s*(-?[\d.,]+)\s*([A-Za-z°][\w°]*)/gim;
  let lineM: RegExpExecArray | null;
  let last: { literal: string; unit: string } | null = null;
  while ((lineM = lineRe.exec(normalized)) !== null) {
    last = { literal: lineM[1], unit: lineM[2] };
  }
  if (!last) return;
  // High-precision doctrine: in a SHAPE-TABLE pack the FINAL ESTIMATE is structurally a
  // downstream span/interpolation result toward a target temperature/time — NOT the bound
  // column's point prediction at the index (the bound column's value is an intermediate
  // anchor mid-derivation). Recomputing the form at the index would wrongly contradict a
  // legitimate multi-step estimate. Only a flat trend-table pack (no shape) makes the
  // FINAL ESTIMATE the model's direct point prediction, so bind there alone.
  if (p.shape !== null || p.shapeCols !== null) return;
  // Run the value through the same comma/space normalization the body got (strip any
  // residual group separators) before parsing the literal.
  const cleanLiteral = last.literal.replace(/[, ]/g, "");
  const claimed = Number(cleanLiteral);
  if (!Number.isFinite(claimed)) return;

  // (1) exactly one trend column bound anywhere: token, near-token, or formula-literal.
  const cols = new Set<string>();
  for (const c of boundColumnTokens(normalized, p)) cols.add(c);
  for (const c of nearTokenColumns(normalized, p)) cols.add(c);
  for (const fb of bindByFormula(normalized, p)) cols.add(fb.col);
  if (cols.size !== 1) return;
  const col = [...cols][0];

  // (2) exactly one distinct in-envelope index k across the answer (per paragraph).
  const ks = new Set<number>();
  for (const para of paras) {
    for (const k of extractIndexRefs(para, p)) ks.add(k);
  }
  const distinctK = [...ks];
  if (distinctK.length !== 1) return;
  const k = distinctK[0];
  if (!inEnvelope(k, p)) return;

  // (3) the line's unit matches the bound column's unit.
  const colUnit = p.columns[col]?.unit ?? "";
  if (!colUnit || normUnit(last.unit) !== normUnit(colUnit)) return;

  // (4) form: prose-named over the whole answer, else the column's stored best.
  const form = formInProse(normalized) ?? p.trends[col]?.best ?? null;
  if (!form) return;
  const fit = fitOf(p.trends[col], form);
  if (!fit) return;

  const recomputed = evalForm(form, fit.params, k);
  const tol = Math.max(REL_PREDICTION * Math.abs(recomputed), halfUlp(cleanLiteral));
  const verdict = Math.abs(claimed - recomputed) > tol ? "flag" : "pass";
  pushClaim(
    out,
    `FINAL ESTIMATE: ${last.literal} ${last.unit}`,
    `${form}(${k}) = ${round(recomputed)} for ${col}`,
    verdict,
    "final-estimate"
  );
}

// ── entry point ──────────────────────────────────────────────────

export function recheckAnswer(pack: PackArtifacts, answer: string): RecheckResult {
  const p = parsePack(pack); // may throw on malformed params_json
  const ds = parseCsv(pack.datasetCsv);
  if (!answer || !answer.trim()) return { claims: [], flags: 0, checked: 0 };

  const out: RecheckClaim[] = [];
  const normalized = normalize(answer);
  const paras = splitParagraphs(normalized);

  // A (col, form) binding established by a formula in one paragraph propagates to
  // later paragraphs of the same derivation chain (until re-bound or a structural
  // break). Lets a prose restatement of a model's predictions inherit the binding
  // the formula pinned upstream. Only ever a single unambiguous binding is carried.
  let carried: { col: string; form: FormName } | null = null;

  // Flattened, in-order sentence list for cross-paragraph window joins (the multi-
  // line ratio derivation in checkRatioWindow routinely spans a paragraph break).
  const allSentences: string[] = [];

  for (const para of paras) {
    const sentences = splitSentences(para);
    allSentences.push(...sentences);
    const boundCols = boundColumnTokens(para, p);
    const formulaBinds = bindByFormula(para, p);
    const proseForm = formInProse(para);

    checkModelPrediction(para, sentences, p, boundCols, formulaBinds, proseForm, out);
    checkSynonymPrediction(para, sentences, p, boundCols, formulaBinds, carried, out);
    checkClausePairedPrediction(para, sentences, p, boundCols, formulaBinds, out);
    checkConstantQuote(para, sentences, p, boundCols, formulaBinds, proseForm, out);
    checkDerivedRatio(para, sentences, p, ds, out);
    checkTrendDirection(para, sentences, p, ds, boundCols, formulaBinds, proseForm, out);
    checkNotesConstant(sentences, p, ds, pack.notes, out);

    // Update / consume the carried binding.
    const ownFormBinds = Array.from(new Set(formulaBinds.map((f) => `${f.col} ${f.form}`)));
    if (ownFormBinds.length === 1) {
      // this paragraph re-pins the chain to its formula's (col, form)
      carried = formulaBinds[0];
    } else if (ownFormBinds.length > 1) {
      carried = null; // ambiguous local binding breaks the chain
    } else if (boundCols.length > 0) {
      // a column token (without a formula) also re-binds, but only if unambiguous
      const f = boundCols.length === 1 ? (proseForm ?? p.trends[boundCols[0]]?.best ?? null) : null;
      carried = boundCols.length === 1 && f && fitOf(p.trends[boundCols[0]], f)
        ? { col: boundCols[0], form: f }
        : null;
    } else if (isStructuralBreak(para)) {
      carried = null;
    } else if (carried) {
      // no own binding → inherit the upstream binding for a prose prediction restatement
      checkCarriedPrediction(para, sentences, p, carried, out);
    }
  }

  // Cross-paragraph derived-ratio window join (multi-line ratio derivations).
  checkRatioWindow(allSentences, p, ds, out);

  // Whole-answer FINAL ESTIMATE summary line (a structural break the per-paragraph
  // passes cannot bind). Runs once over the normalized answer.
  checkFinalEstimate(normalized, paras, p, out);

  const flags = out.filter((c) => c.verdict === "flag").length;
  return { claims: out, flags, checked: out.length };
}
