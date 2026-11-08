// Spec tests for numeric-reconcile (see docs/CHANNEL-SEPARATION-DOCTRINE.md).
// Each fixture pins a dialect/tolerance rule; mutating the rule it names must fail it.
import { describe, expect, test } from "bun:test";
import { acceptancePass, numericReconcile } from "../src/gates/numeric-reconcile.ts";

const flagged = (src: string, art: string) => numericReconcile(src, art).untraceable.map((u) => u.literal);

describe("provenance: fabrication detection", () => {
  test("fabricated decimal flags (the V1 0.013 shape)", () => {
    const src = "Probe accuracy is 0.993 for the base model and 0.543±0.033 for variant G.";
    const art = "Variant G: probe accuracy drops from 0.993 to 0.013.";
    expect(flagged(src, art)).toEqual(["0.013"]);
  });

  test("error-bar magnitude is not citable by a bare point-value claim", () => {
    const src = "Accuracy 0.705±1.3e-2 across seeds.";
    expect(flagged(src, "The accuracy floor is 0.013.")).toEqual(["0.013"]);
  });

  test("a ±-marked claim traces to the source error bar", () => {
    const src = "Accuracy 0.705±1.3e-2 across seeds.";
    expect(flagged(src, "Reported as 0.705±1.3e-2.")).toEqual([]);
  });

  test("percent dialect is claim-side only", () => {
    expect(flagged("The fraction reached 0.432 at convergence.", "It improved 43.2%.")).toEqual([]);
    // source percent must NOT excuse a bare artifact fraction (laundering direction)
    expect(flagged("A 1.3% improvement was observed.", "The value fell to 0.013.")).toEqual(["0.013"]);
  });

  test("artifact may round the source value, not exceed its precision", () => {
    expect(flagged("Measured 0.543 exactly.", "Roughly 0.54 was measured.")).toEqual([]);
    expect(flagged("Measured 0.543 exactly.", "Precisely 0.5432 was measured.")).toEqual(["0.5432"]);
  });

  test("coarse integer cannot absorb distant values (REL_ROUND_CAP)", () => {
    expect(flagged("We sampled 1500 items.", "About 1000 items were sampled.")).toEqual(["1000"]);
  });

  test("derived value passes only with same-sentence traceable operands", () => {
    const src = "Group A scored 0.25 and group B scored 0.75 on the benchmark.";
    expect(flagged(src, "Combined score 1.00 (0.25 + 0.75 across groups).")).toEqual([]);
    expect(flagged(src, "The combined score is 0.41.")).toEqual(["0.41"]);
  });

  test("fused column-code depeel recovers real values, not fabrications", () => {
    const src = "Gala Apples\n0956/2\n525.2\n0996/9\n423.7\n";
    // normalize() glues "0956/2 525.2" into "0956/2525.2" — must still trace
    expect(flagged(src, "Methanol: 0956/2 525.2; 0996/9 423.7")).toEqual([]);
    // adversarial control: a peeled value absent from source still flags
    expect(flagged(src, "Methanol: 0956/2 999.9")).toEqual(["2999.9"]);
  });
});

describe("provenance: structural-number dialects are not candidates", () => {
  test("heading and inline section labels", () => {
    const art = "### 1.2 Methods\nWe proceed. 1.3 The body is a convergent indicator.";
    expect(flagged("No numbers here.", art)).toEqual([]);
  });

  test("citation brackets and keyword cross-references", () => {
    const art = "Stated rule [Section: Abstract, 2, 3.3] per Sections 3.1-3.7 (Framework Tension 6.1).";
    expect(flagged("No numbers here.", art)).toEqual([]);
  });

  test("a bare X.Y value in prose is still a candidate", () => {
    expect(flagged("No numbers here.", "The loss plateaued at 3.3 after warmup.")).toEqual(["3.3"]);
  });

  test("years and small integers are not candidates; big integers are", () => {
    expect(flagged("No numbers here.", "In 2024 we ran 12 trials on 48842 samples.")).toEqual(["48842"]);
  });
});

const DENSE_SRC = [
  "Results table:",
  "0.571 0.543 7.197 0.649",
  "0.612 0.633 5.402 0.701",
  "0.498 0.587 6.918 0.622",
].join("\n");

describe("acceptance: load-bearing coverage", () => {
  test("artifact carrying the table passes; artifact dropping it fails", () => {
    const carrying = numericReconcile(DENSE_SRC, "Ablations: 0.571, 0.543, 7.197, 0.649, 0.612, 0.633, 5.402, 0.701, 0.498, 0.587, 6.918.");
    expect(carrying.minRegionCoverage).toBeGreaterThan(0.9);
    expect(acceptancePass(carrying)).toBe(true);
    const starved = numericReconcile(DENSE_SRC, "The text reports detailed ablation results.");
    expect(starved.minRegionCoverage).toBe(0);
    expect(acceptancePass(starved)).toBe(false);
  });

  test("no dense region = vacuous pass (in-distribution prose sources)", () => {
    const r = numericReconcile("Salt the chicken. Wait for the roast aroma. Use beef tallow.", "A cooking lens.");
    expect(r.loadBearing).toBe(0);
    expect(r.coverage).toBe(1);
    expect(acceptancePass(r)).toBe(true);
  });

  test("reference/bibliography regions are excluded from load-bearing", () => {
    const refs = [
      "Smith, J. Biometrika, 70(3): 723-726, 1983. ISSN 1464-3510. doi: 10.1093/biomet/70.3.723.",
      "Lee, K. In Proceedings of ICML, pp. 1234-1245, 2019. doi: 10.1145/2939672.2939785.",
      "Cortez, P. UCI Repository, 2014. doi: 10.24432/C5K306. arXiv:1803.10122.",
      "Moro, S. ACM, 2019. doi: 10.1145/3357384.3357925. ISSN 0018-9219.",
    ].join("\n");
    const r = numericReconcile(refs, "A lens with no numbers.");
    expect(r.loadBearing).toBe(0);
    expect(acceptancePass(r)).toBe(true);
  });

  test("error bars are not load-bearing", () => {
    const src = ["Table:", "0.571±0.002 0.543±0.001 7.197±0.012 0.649±0.003", "0.612±0.004 0.633±0.001 5.402±0.020 0.701±0.002", "0.498±0.003 0.587±0.002 6.918±0.015 0.622±0.001"].join("\n");
    const r = numericReconcile(src, "Values: 0.571, 0.543, 7.197, 0.649, 0.612, 0.633, 5.402, 0.701, 0.498, 0.587, 6.918, 0.622.");
    expect(r.missing.map((m) => m.literal)).toEqual([]);
    expect(acceptancePass(r)).toBe(true);
  });
});

describe("entity telemetry (report-only)", () => {
  test("variant labels from dense regions are checked by substring", () => {
    const src = ["Ablation results:", "Variant G 0.543 0.571 7.197 0.649", "Variant H 0.612 0.633 5.402 0.701", "Variant I 0.498 0.587 6.918 0.622"].join("\n");
    const r = numericReconcile(src, "Variant G dropped sharply. Values 0.543 0.571 7.197 0.649 0.612 0.633 5.402 0.701 0.498 0.587 6.918 0.622.");
    const missing = r.entities.filter((e) => !e.present).map((e) => e.phrase);
    expect(missing).toContain("Variant H");
    expect(missing).not.toContain("Variant G");
  });
});
