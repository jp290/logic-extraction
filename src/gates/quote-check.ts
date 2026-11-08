// Deterministic quote verifier: every double-quoted span in a synthesized doc should be
// traceable to the source. Catches paraphrases dressed as verbatim quotes — the one
// fidelity defect that survives model upgrades. Pure string matching; no LLM call.
//
// Exact substring matching is too strict (a verbatim quote that drops a "[23]" citation
// or spans a line break fails it). Instead we measure COVERAGE: the fraction of the
// quote's words that belong to a long contiguous run also present in the source. A real
// quote — even with a dropped citation or minor elision — is almost fully covered; a
// fabricated quote is mostly uncovered.

export interface QuoteFinding {
  quote: string;
  coverage: number; // 0..1 fraction of words inside a >=RUN run found in source
  verified: boolean;
}

function normWords(s: string): string[] {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/(\w)-\s+(\w)/g, "$1$2") // join hyphenated line breaks
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ") // drop punctuation, citation brackets, ellipses
    .split(/\s+/)
    .filter(Boolean);
}

const MIN_WORDS = 4; // shorter quotes false-positive too easily
const RUN = 4; // a contiguous run of this many quote-words must appear in source to "cover"
const COVERAGE_THRESHOLD = 0.7; // below this fraction covered → suspected fabrication

function coverage(quoteWords: string[], sourceText: string): number {
  if (quoteWords.length < RUN) return 0;
  // Build a set of RUN-grams present in the source for O(1) lookup.
  const srcWords = normWords(sourceText);
  const grams = new Set<string>();
  for (let i = 0; i + RUN <= srcWords.length; i++) {
    grams.add(srcWords.slice(i, i + RUN).join(" "));
  }
  // Mark every quote word that participates in any matching RUN-gram.
  const covered = new Array<boolean>(quoteWords.length).fill(false);
  for (let i = 0; i + RUN <= quoteWords.length; i++) {
    if (grams.has(quoteWords.slice(i, i + RUN).join(" "))) {
      for (let j = i; j < i + RUN; j++) covered[j] = true;
    }
  }
  return covered.filter(Boolean).length / quoteWords.length;
}

export function checkQuotes(doc: string, source: string): QuoteFinding[] {
  const findings: QuoteFinding[] = [];
  const seen = new Set<string>();
  for (const match of doc.matchAll(/"([^"“”]{1,600})"|“([^"“”]{1,600})”/g)) {
    const raw = (match[1] ?? match[2]).trim();
    // Skip the LD's own shorthand dressed in quotes — pseudocode labels (semicolons)
    // and rhetorical/heuristic questions are not source-attribution quotes.
    if (raw.includes(";") || raw.endsWith("?")) continue;
    const words = normWords(raw);
    if (words.length < MIN_WORDS) continue;
    const key = words.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    const cov = coverage(words, source);
    findings.push({ quote: raw, coverage: cov, verified: cov >= COVERAGE_THRESHOLD });
  }
  return findings;
}

export function quoteReport(doc: string, source: string): { total: number; fabricated: QuoteFinding[] } {
  const findings = checkQuotes(doc, source);
  return { total: findings.length, fabricated: findings.filter((f) => !f.verified) };
}
