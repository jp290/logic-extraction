// Write-path gates. Every lens document passes the deterministic quote gate before it
// is stored; KE and UD additionally get numeric provenance reports.

import { quoteReport } from "../gates/quote-check.ts";
import { acceptancePass, numericReconcile } from "../gates/numeric-reconcile.ts";

// Layer-1 deterministic fidelity gate: any quoted span the checker can't trace to the
// reference corpus loses its quotation marks (the false "this is verbatim" claim);
// content is preserved unchanged. Returns the repaired doc plus an audit entry for
// grounding_report. Spans the replace can't locate (smart quotes/nesting) stay flagged.
export function unquoteUnverified(doc: string, corpus: string): { doc: string; total: number; repaired: number; flagged: { quote: string; coverage: number }[] } {
  const before = quoteReport(doc, corpus);
  let out = doc;
  let repaired = 0;
  for (const f of before.fabricated) {
    for (const wrapped of [`"${f.quote}"`, `“${f.quote}”`]) {
      if (out.includes(wrapped)) {
        out = out.replaceAll(wrapped, f.quote);
        repaired++;
        break;
      }
    }
  }
  const after = quoteReport(out, corpus);
  return {
    doc: out,
    total: before.total,
    repaired,
    flagged: after.fabricated.map((f) => ({ quote: f.quote, coverage: Math.round(f.coverage * 100) / 100 })),
  };
}

// Gate a document and record the result under `key` in a JSON grounding report string.
// Every lens-content write path must pass through unquoteUnverified — LLM verifiers
// are not equivalent (measured: the gate caught fabrications the VK/VU agents missed).
export function gateDoc(doc: string, corpus: string, reportJson: string, key: string): { doc: string; reportJson: string } {
  const gate = unquoteUnverified(doc, corpus);
  let report: Record<string, unknown>;
  try { report = JSON.parse(reportJson); } catch { report = {}; }
  report[key] = { total: gate.total, repaired: gate.repaired, flagged: gate.flagged };
  return { doc: gate.doc, reportJson: JSON.stringify(report) };
}

// Numeric provenance/acceptance gate (V2 Phase 2). Repair policy: LABEL ONLY in
// path — flagged numbers are never stripped (an FP strip would re-create the V1
// starvation, instrument-induced). The label is a delimited note appended to the
// KE the UD consumes; the STORED KE stays clean (the note is never persisted —
// that is the build-time finalization "strip", which removes only the label,
// never content). Report stores PRE-repair flags: Phase-3 gates on flag count.
export function applyKeNumericGate(id: string, sourceText: string, finalKe: string, groundingReport: string): { keForUd: string; groundingReport: string } {
  let keForUd = finalKe;
  try {
    const keNumeric = numericReconcile(sourceText, finalKe);
    const existingReport = JSON.parse(groundingReport);
    existingReport.keNumericReconcile = {
      flags: keNumeric.untraceable.length,
      measuredContextFlags: keNumeric.untraceable.filter((u) => u.measuredContext).length,
      untraceable: keNumeric.untraceable.map((u) => ({ literal: u.literal, measuredContext: u.measuredContext, context: u.context })),
      minRegionCoverage: keNumeric.minRegionCoverage,
      coverage: keNumeric.coverage,
      loadBearing: keNumeric.loadBearing,
      acceptance: keNumeric.loadBearing === 0 ? "vacuous-pass" : acceptancePass(keNumeric) ? "pass" : "fail",
    };
    groundingReport = JSON.stringify(existingReport);
    if (keNumeric.untraceable.length > 0) {
      const lines = keNumeric.untraceable.map((u) => `- ${u.literal} (near: "…${u.context.slice(0, 110)}…")`);
      keForUd = `${finalKe}\n\n=== NUMERIC PROVENANCE NOTE (deterministic gate — not source content) ===\nThe following numbers above could NOT be traced to the source text. Do not treat them as established measurements and do not propagate them into your synthesis without explicit hedging:\n${lines.join("\n")}\n=== END NUMERIC PROVENANCE NOTE ===`;
    }
  } catch (err) {
    console.error(`[applyKeNumericGate] Numeric reconcile failed for extraction ${id}:`, err);
  }
  return { keForUd, groundingReport };
}

// Report-only UD provenance entry (Phase-3 gates read it offline as well).
export function addUdNumericReport(id: string, sourceText: string, understanding: string, groundingReport: string): string {
  try {
    const udNumeric = numericReconcile(sourceText, understanding);
    const existingReport = JSON.parse(groundingReport);
    existingReport.udNumericReconcile = {
      flags: udNumeric.untraceable.length,
      measuredContextFlags: udNumeric.untraceable.filter((u) => u.measuredContext).length,
      untraceable: udNumeric.untraceable.map((u) => ({ literal: u.literal, measuredContext: u.measuredContext, context: u.context })),
    };
    return JSON.stringify(existingReport);
  } catch (err) {
    console.error(`[addUdNumericReport] UD numeric reconcile failed for extraction ${id}:`, err);
    return groundingReport;
  }
}
