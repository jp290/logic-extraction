import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { recheckAnswer, type PackArtifacts } from "../src/gates/recheck.ts";

const FIX = join(import.meta.dir, "fixtures", "recheck");

function loadPack(name: string): PackArtifacts {
  const raw = JSON.parse(readFileSync(join(FIX, `${name}.pack.json`), "utf-8")) as {
    params_json: string;
    dataset_csv: string;
    column_spec: string;
    notes: string;
  };
  return {
    paramsJson: raw.params_json,
    datasetCsv: raw.dataset_csv,
    columnSpec: raw.column_spec,
    notes: raw.notes,
  };
}

function loadAnswer(name: string): string {
  return readFileSync(join(FIX, `${name}.md`), "utf-8");
}

const battery = loadPack("battery");
const thermal = loadPack("thermal");

describe("battery U1 — model-prediction offense", () => {
  const res = recheckAnswer(battery, loadAnswer("battery-U1"));

  test("exactly 1 flag", () => {
    expect(res.flags).toBe(1);
  });

  test("flagged claim is the ~2590 t_cutoff_s prediction; recomputed ~2536.8", () => {
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
    expect(flagged[0].claim).toContain("2590");
    expect(flagged[0].recomputed).toContain("2536.8");
  });

  test("the 0.0322 Ah MAE quote, if extracted, passes", () => {
    const maeClaims = res.claims.filter((c) => c.kind === "constant-quote" && c.claim.includes("0.0322"));
    for (const c of maeClaims) expect(c.verdict).toBe("pass");
  });
});

describe("battery U2 — derived-ratio + two trend-direction offenses", () => {
  const res = recheckAnswer(battery, loadAnswer("battery-U2"));
  const flagged = res.claims.filter((c) => c.verdict === "flag");

  test("exactly 3 flags", () => {
    expect(res.flags).toBe(3);
  });

  test("(a) derived-ratio at cycle 110 — claim has 70, recomputed ~61.6%", () => {
    const dr = flagged.filter((c) => c.kind === "derived-ratio");
    expect(dr.length).toBe(1);
    expect(dr[0].claim).toContain("70");
    expect(dr[0].recomputed).toContain("61.6");
  });

  test("(b) trend-direction model — form RISES initially", () => {
    const td = flagged.filter((c) => c.kind === "trend-direction" && /RISES initially/i.test(c.recomputed));
    expect(td.length).toBe(1);
  });

  test("(c) trend-direction data — measured rise", () => {
    const td = flagged.filter((c) => c.kind === "trend-direction" && /measured RISES/i.test(c.recomputed));
    expect(td.length).toBe(1);
  });
});

describe("battery U3 — notes-constant offense", () => {
  const res = recheckAnswer(battery, loadAnswer("battery-U3"));
  const flagged = res.claims.filter((c) => c.verdict === "flag");

  test("exactly 1 flag", () => {
    expect(res.flags).toBe(1);
  });

  test("flag is notes-constant, cites charge 1.5 A, claim mentions 2 A / 2 A", () => {
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("notes-constant");
    expect(flagged[0].recomputed).toContain("1.5 A");
    expect(flagged[0].claim).toMatch(/2\s*A\s*\/\s*2\s*A/);
  });

  test("no 4 A hypothetical is extracted as a flag", () => {
    for (const c of flagged) expect(c.claim).not.toContain("4 A");
  });
});

describe("thermal U3 GROUNDED — span-fraction offense + passing predictions", () => {
  const res = recheckAnswer(thermal, loadAnswer("thermal-U3"));
  const flagged = res.claims.filter((c) => c.verdict === "flag");

  test("exactly 1 flag", () => {
    expect(res.flags).toBe(1);
  });

  test("flag is the span fraction — claim has 54, recomputed 62.5", () => {
    expect(flagged.length).toBe(1);
    expect(flagged[0].claim).toContain("54");
    expect(flagged[0].recomputed).toContain("62.5");
  });

  test(">= 2 passing model-prediction claims (the 42.1 / 32.9 / 37.5 bullets)", () => {
    const passingPreds = res.claims.filter((c) => c.kind === "model-prediction" && c.verdict === "pass");
    expect(passingPreds.length).toBeGreaterThanOrEqual(2);
  });
});

describe("clean T answers — zero flags", () => {
  const cleanFiles = [
    "battery-T1", "battery-T2", "battery-T3", "battery-T4", "battery-T5", "battery-T6",
    "thermal-grounded-T1", "thermal-grounded-T2", "thermal-grounded-T3",
    "thermal-grounded-T4", "thermal-grounded-T5", "thermal-grounded-T6",
    "thermal-pack-T1", "thermal-pack-T2", "thermal-pack-T3",
    "thermal-pack-T4", "thermal-pack-T5", "thermal-pack-T6",
  ];

  for (const f of cleanFiles) {
    const pack = f.startsWith("battery") ? battery : thermal;
    test(`${f} → 0 flags`, () => {
      const res = recheckAnswer(pack, loadAnswer(f));
      const flagged = res.claims.filter((c) => c.verdict === "flag");
      if (flagged.length > 0) {
        throw new Error(`${f} false-positives:\n` + flagged.map((c) => `  [${c.kind}] ${c.claim}\n    => ${c.recomputed}`).join("\n"));
      }
      expect(res.flags).toBe(0);
    });
  }
});

describe("edge cases", () => {
  test("empty answer → checked 0, flags 0", () => {
    const res = recheckAnswer(battery, "");
    expect(res.checked).toBe(0);
    expect(res.flags).toBe(0);
    expect(res.claims).toEqual([]);
  });

  test("whitespace-only answer → checked 0", () => {
    const res = recheckAnswer(battery, "   \n\n  ");
    expect(res.checked).toBe(0);
  });

  test("numbers without bindable anchors → 0 claims", () => {
    const res = recheckAnswer(battery, "the answer is 42 and 7% better");
    expect(res.claims.length).toBe(0);
  });

  test("never throws on arbitrary answer text", () => {
    expect(() => recheckAnswer(battery, "√√√ k = NaN ∞ at cycle ∞ %%% A/A")).not.toThrow();
  });

  test("shape-only pack (no trends) handled", () => {
    const shapeOnly: PackArtifacts = {
      paramsJson: JSON.stringify({
        trends: {},
        index: null,
        split: null,
        shape: { val_mae: 2.1 },
        shape_cols: ["batch", "t_min", "T_c"],
        spec: { columns: { batch: { role: "group" }, t_min: { role: "x", unit: "min" }, T_c: { role: "y", unit: "°C" } } },
      }),
      datasetCsv: "batch,t_min,T_c\n1,0,80\n1,30,50\n1,60,40\n",
      columnSpec: "{}",
      notes: "",
    };
    expect(() => recheckAnswer(shapeOnly, "Some prose about cooling at batch 1.")).not.toThrow();
  });

  test("malformed params_json throws (caller catches)", () => {
    const bad: PackArtifacts = { paramsJson: "{not json", datasetCsv: "", columnSpec: "{}", notes: "" };
    expect(() => recheckAnswer(bad, "anything")).toThrow();
  });
});

describe("mutation check — flag comes from arithmetic, not text matching", () => {
  test("battery U1 with the 2590 edited to the correct 2537 → 0 flags", () => {
    const answer = loadAnswer("battery-U1").replace("~2590 s", "~2537 s");
    const res = recheckAnswer(battery, answer);
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(0);
  });
});

describe("live LaTeX answer — production pro output (smoke consult 2026-06-11)", () => {
  const answer = loadAnswer("battery-live-latex");

  test("extracts the display-math prediction and passes it", () => {
    const res = recheckAnswer(battery, answer);
    expect(res.flags).toBe(0);
    const preds = res.claims.filter((c) => c.kind === "model-prediction" && c.verdict === "pass");
    expect(preds.length).toBe(1);
    expect(preds[0].recomputed).toContain("2603.9");
  });

  test("mutated derivation value flags", () => {
    const res = recheckAnswer(battery, answer.replace("2603.8616", "2700.5"));
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
  });

  test("derivation split by a bare connective ('gives') still extracts", () => {
    const answer2 = loadAnswer("battery-live-latex-2");
    const res = recheckAnswer(battery, answer2);
    expect(res.flags).toBe(0);
    const preds = res.claims.filter((c) => c.kind === "model-prediction" && c.verdict === "pass");
    expect(preds.length).toBe(1);
    expect(preds[0].recomputed).toContain("1.527");
    const mutated = recheckAnswer(battery, answer2.replace("1.5266", "1.62"));
    expect(mutated.flags).toBe(1);
  });

  test("scientific notation + soft-wrapped exponential derivation extracts", () => {
    const answer3 = loadAnswer("thermal-live-latex");
    const res = recheckAnswer(thermal, answer3);
    expect(res.flags).toBe(0);
    const preds = res.claims.filter((c) => c.kind === "model-prediction" && c.verdict === "pass");
    expect(preds.length).toBe(1);
    expect(preds[0].recomputed).toContain("40.86");
    const mutated = recheckAnswer(thermal, answer3.replace("40.86\\ \\text{min}", "44.2\\ \\text{min}"));
    expect(mutated.flags).toBe(1);
  });

  test("live true positive — sign-error fabrication flags (smoke consult 5)", () => {
    // Production pro answer dropped the minus sign on b for T_at_20min_c linear
    // and predicted 51.21 °C; the stored fit gives 60.47 °C at batch 100.
    const answer5 = loadAnswer("thermal-live-sign-error");
    const res = recheckAnswer(thermal, answer5);
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
    expect(flagged[0].recomputed).toContain("60.47");
    const corrected = recheckAnswer(thermal, answer5.replaceAll("51.21008", "60.47012").replaceAll("51.21", "60.47"));
    expect(corrected.flags).toBe(0);
  });

  test("bullet-list derivation pairs at block level", () => {
    const answer4 = loadAnswer("battery-live-bullets");
    const res = recheckAnswer(battery, answer4);
    expect(res.flags).toBe(0);
    const preds = res.claims.filter((c) => c.kind === "model-prediction" && c.verdict === "pass");
    expect(preds.length).toBe(1);
    expect(preds[0].recomputed).toContain("3.590");
    const mutated = recheckAnswer(battery, answer4.replace("3.58994", "3.72").replace("3.590", "3.72"));
    expect(mutated.flags).toBe(1);
  });
});

describe("battery U1 live mis-bind — voltage claim must not flag against a seconds column", () => {
  // Production pack-only answer (gate-calibration, ans-battery-U1__packonly). The
  // t_cutoff_s formula 3408.14-6.7023 k binds (t_cutoff_s, linear) for the paragraph.
  // A later bullet ("If the 1000 s voltage slips below 3.55 V (the projected value near
  // cycle 134)...") carries v_at_1000s AND v_at_1800s tokens (two cols, ambiguous), so it
  // falls back to the paragraph t_cutoff_s binding and used to match the "1000 s" time
  // anchor, comparing it against the 2510 s recomputation and FLAGGING — a false positive,
  // since 3.55 V is consistent with v_at_1000s (linear 3.562 V / sqrt_linear 3.509 V at 134).
  const answer = loadAnswer("battery-u1-live-misbind");
  const res = recheckAnswer(battery, answer);
  const preds = res.claims.filter((c) => c.kind === "model-prediction");

  test("zero flags for the whole answer", () => {
    expect(res.flags).toBe(0);
  });

  test("the t_cutoff_s prediction still extracts and passes, recomputed 2510", () => {
    const at134 = preds.find((c) => c.recomputed.includes("t_cutoff_s"));
    expect(at134).toBeDefined();
    expect(at134?.verdict).toBe("pass");
    expect(at134?.recomputed).toContain("2510");
    expect(at134?.claim).toContain("2500 s");
  });

  test("the voltage bullet is never flagged (not bound to t_cutoff_s)", () => {
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(0);
    const voltageBound = res.claims.filter((c) => /3\.55 V|slips below/i.test(c.claim));
    expect(voltageBound.length).toBe(0);
  });

  test("mutation: 2500 s → 2800 s yields exactly 1 flag (pass comes from arithmetic)", () => {
    // raw text separates "2500" from "s" with a narrow no-break space; mutate the literal.
    const mutated = recheckAnswer(battery, answer.replace("2500", "2800"));
    const mFlagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(mutated.flags).toBe(1);
    expect(mFlagged.length).toBe(1);
    expect(mFlagged[0].kind).toBe("model-prediction");
    expect(mFlagged[0].recomputed).toContain("t_cutoff_s");
  });
});

describe("battery T4 inverse+forward — carried formula binding across paragraphs", () => {
  // Production lens+pack answer (gate-calibration, ans-battery-T4__lenspack). A formula
  // C(k)=1.89684-0.00370267 k binds capacity_ah+linear in one paragraph; two paragraphs
  // later the linear model's forward predictions are restated in prose ("At cycle 134
  // C≈1.4007 Ah; at cycle 135 C≈1.3970 Ah") with neither column token nor formula. The
  // binding must propagate forward so both forward predictions extract and pass, while
  // the inverse claim ("first cycle ... below 1.40 Ah is cycle 135") stays unextracted.
  const answer = loadAnswer("battery-t4-inverse-forward");
  const res = recheckAnswer(battery, answer);
  const preds = res.claims.filter((c) => c.kind === "model-prediction");

  test("extracts exactly the two forward predictions, both passing", () => {
    expect(res.checked).toBe(2);
    expect(res.flags).toBe(0);
    expect(preds.length).toBe(2);
    for (const c of preds) expect(c.verdict).toBe("pass");
  });

  test("recomputes capacity_ah at cycle 134 (1.401) and 135 (1.397)", () => {
    const at134 = preds.find((c) => c.recomputed.includes("(134)"));
    const at135 = preds.find((c) => c.recomputed.includes("(135)"));
    expect(at134?.recomputed).toContain("1.401");
    expect(at134?.recomputed).toContain("capacity_ah");
    expect(at135?.recomputed).toContain("1.397");
  });

  test("the inverse claim (value-before-index) is NOT extracted", () => {
    // "...the first cycle where the linear model predicts capacity below 1.40 Ah is
    // cycle 135" — the 1.40 Ah threshold precedes the index, so no forward pair binds.
    const inverse = res.claims.filter((c) => /first cycle where/i.test(c.claim));
    expect(inverse.length).toBe(0);
  });

  test("mutation: 1.4007 → 1.35 yields exactly 1 flag, the 1.3970 claim still passes", () => {
    const mutated = recheckAnswer(battery, answer.replace("1.4007", "1.35"));
    const mPreds = mutated.claims.filter((c) => c.kind === "model-prediction");
    expect(mutated.flags).toBe(1);
    expect(mPreds.length).toBe(2);
    const flagged = mPreds.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].recomputed).toContain("(134)");
    const at135 = mPreds.find((c) => c.recomputed.includes("(135)"));
    expect(at135?.verdict).toBe("pass");
  });
});

describe("battery U2 live diff-ratio — cross-column difference growth must not flag", () => {
  // Production pack-only answer (gate-calibration, ans-battery-U2__packonly). The sentence
  // "The difference v(1000 s) - v(1800 s) grows from 0.134 V (cycle 1) to 0.151 V (cycle
  // 110), i.e., ... increases by about 13 %" is TRUE: at cycle 1 the same-unit difference
  // v_at_1000s − v_at_1800s = 0.1340 V; at cycle 110 = 0.1506 V; growth = 12.4% ≈ "about
  // 13%". The old single-value-column candidate set {X/v, 1−X/v} could not represent it, so
  // both per-index extractions flagged. The growth path grounds each quantity as a same-unit
  // difference of two value columns and compares the pack-grounded ratio to the claim.
  const NB = " "; // narrow no-break space used in the live answer
  const answer = loadAnswer("battery-u2-live-diffratio");
  const res = recheckAnswer(battery, answer);

  test("zero flags for the whole answer", () => {
    expect(res.flags).toBe(0);
  });

  test("the 22% capacity-loss and 31% SOC claims still extract and pass", () => {
    const cap = res.claims.filter((c) => c.recomputed.includes("matches 22%") && c.verdict === "pass");
    const soc = res.claims.filter((c) => c.recomputed.includes("matches 31%") && c.verdict === "pass");
    expect(cap.length).toBe(1);
    expect(soc.length).toBe(1);
  });

  test("the diff-ratio sentence is grounded and passes (12.4% within 3pp of 13%)", () => {
    const dr = res.claims.filter((c) => /grounded 0\.1340@1/.test(c.recomputed));
    expect(dr.length).toBe(1);
    expect(dr[0].kind).toBe("derived-ratio");
    expect(dr[0].verdict).toBe("pass");
    expect(dr[0].recomputed).toContain("12.388%");
  });

  test("mutation: 'about 13 %' → 'about 30 %' flags the diff-ratio sentence (arithmetic, not text)", () => {
    const mutated = recheckAnswer(battery, answer.replace(`13${NB}%`, `30${NB}%`));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(mutated.flags).toBe(1);
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("derived-ratio");
    expect(flagged[0].recomputed).toContain("vs claimed 30%");
  });
});

describe("battery U3 live hypothetical — question-restatement must not extract a notes-constant", () => {
  // Production lens+pack answer (gate-calibration, ans-battery-U3__lenspack). The sentence
  // "The question asks what happens if the same aged cell is discharged at 4.0 A instead." is
  // a restatement of the question's hypothetical ("must now discharge at 4.0 A instead of 2.0
  // A"). The assertive-current regex caught "cell is discharged at 4.0 A" because the
  // hypothetical marker ("asks what", "if", "instead") sat earlier in the sentence. Spec:
  // hypotheticals must NOT match — so the sentence carries a hypothetical marker → no extract.
  const NB = " ";
  const answer = loadAnswer("battery-u3-live-hypothetical");
  const res = recheckAnswer(battery, answer);

  test("nothing extractable — checked 0, flags 0", () => {
    expect(res.checked).toBe(0);
    expect(res.flags).toBe(0);
  });

  test("mutation: rewritten assertively → exactly 1 flag vs notes discharge 2.0 A", () => {
    const target = `The question asks what happens if the same aged cell is discharged at 4.0${NB}A instead.`;
    expect(answer.includes(target)).toBe(true);
    const mutated = recheckAnswer(battery, answer.replace(target, `The same aged cell was discharged at 4.0${NB}A.`));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(mutated.flags).toBe(1);
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("notes-constant");
    expect(flagged[0].recomputed).toContain("discharge 2 A");
    expect(flagged[0].recomputed).toContain("claimed 4 A");
  });
});

describe("battery B prose-trap lens+pack — unit-unique synonym binding", () => {
  // Production lens+pack answer (gate-calibration, ans-battery-B__lenspack). One prose
  // sentence with neither a column token nor a quoted formula: "At cycle 105, the linear
  // trend predicts a discharge capacity of 1.5081 Ah, and that model's held-out validation
  // MAE is 0.0322 Ah." BOTH claims are correct (linear capacity_ah(105)=1.50806; stored
  // val_mae=0.0322296). Ah is unit-unique to capacity_ah, the noun "capacity" is present,
  // and the form "linear" is named, so the model-prediction and the MAE constant-quote
  // both bind via prose register and pass.
  const answer = loadAnswer("battery-b-prose-trap");
  const res = recheckAnswer(battery, answer);

  test("checked >= 2 and zero flags", () => {
    expect(res.checked).toBeGreaterThanOrEqual(2);
    expect(res.flags).toBe(0);
  });

  test("the model-prediction binds capacity_ah linear at cycle 105 and passes (recompute 1.508)", () => {
    const pred = res.claims.filter((c) => c.kind === "model-prediction");
    expect(pred.length).toBe(1);
    expect(pred[0].verdict).toBe("pass");
    expect(pred[0].recomputed).toContain("linear(105)");
    expect(pred[0].recomputed).toContain("1.508");
    expect(pred[0].recomputed).toContain("capacity_ah");
  });

  test("the MAE constant-quote binds capacity_ah linear and passes", () => {
    const cq = res.claims.filter((c) => c.kind === "constant-quote");
    expect(cq.length).toBe(1);
    expect(cq[0].verdict).toBe("pass");
    expect(cq[0].recomputed).toContain("capacity_ah linear");
  });

  test("mutation: 1.5081 → 1.45 flags exactly the model-prediction", () => {
    const mutated = recheckAnswer(battery, answer.replace("1.5081", "1.45"));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(mutated.flags).toBe(1);
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
  });

  test("mutation: 0.0322 → 0.05 flags exactly the constant-quote", () => {
    const mutated = recheckAnswer(battery, answer.replace("0.0322", "0.05"));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(mutated.flags).toBe(1);
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("constant-quote");
  });
});

describe("battery B prose-trap pack-only — rounded prose still binds and passes", () => {
  // Production pack-only answer (gate-calibration, ans-battery-B__packonly): "The linear
  // capacity trend predicts a discharge capacity of 1.508 Ah at cycle 105, with a held-out
  // validation MAE of 0.032 Ah." Same binding as the lens+pack trap but with rounded
  // literals (1.508 has half-ulp 0.0005; recomputation is 1.50806 → within tolerance).
  const answer = loadAnswer("battery-b-prose-trap-2");
  const res = recheckAnswer(battery, answer);

  test("checked >= 2 and zero flags", () => {
    expect(res.checked).toBeGreaterThanOrEqual(2);
    expect(res.flags).toBe(0);
  });

  test("the 1.508 model-prediction passes against the 1.50806 recomputation", () => {
    const pred = res.claims.filter((c) => c.kind === "model-prediction");
    expect(pred.length).toBe(1);
    expect(pred[0].verdict).toBe("pass");
    expect(pred[0].recomputed).toContain("capacity_ah");
  });

  test("the 0.032 MAE constant-quote passes", () => {
    const cq = res.claims.filter((c) => c.kind === "constant-quote");
    expect(cq.length).toBe(1);
    expect(cq[0].verdict).toBe("pass");
  });
});

describe("battery U1 prose-register — MAE binds, measured/slope asides do NOT", () => {
  // Production lens+pack answer (gate-calibration, ans-battery-U1__lenspack). A multi-
  // paragraph prose answer quoting the linear slope (–0.00370 Ah/cycle), the validation
  // MAE (0.032 Ah), and dataset values (measured capacity 1.449 Ah at cycle 110), with no
  // column token or formula anywhere. The unit-unique Ah noun-bind must extract ONLY the
  // MAE constant-quote (which passes); the measured value (1.449 Ah, off the model by 4%)
  // and the slope/error asides must stay unextracted because they are not prediction-cued
  // model outputs — high precision over recall avoids a false flag on a measured value.
  const answer = loadAnswer("battery-u1-prose-register");
  const res = recheckAnswer(battery, answer);

  test("zero flags", () => {
    expect(res.flags).toBe(0);
  });

  test("extracts exactly one claim: the MAE constant-quote, passing", () => {
    expect(res.checked).toBe(1);
    expect(res.claims.length).toBe(1);
    expect(res.claims[0].kind).toBe("constant-quote");
    expect(res.claims[0].verdict).toBe("pass");
    expect(res.claims[0].recomputed).toContain("capacity_ah linear");
  });

  test("no model-prediction is extracted from a measured value or a slope aside", () => {
    const preds = res.claims.filter((c) => c.kind === "model-prediction");
    expect(preds.length).toBe(0);
  });
});

describe("thermal T1 latex-derivation — near-token + shared block index", () => {
  // Production lens+pack answer (gate-calibration, ans-thermal-T1__lenspack). Two
  // bullets restate model predictions in a latex dialect: "Tat20min: ... (linear,
  // ...) (T_{20} = 55.8401 + 0.0463002 × 47 = 58.02 °C)" and "tto45c: ... (exponential)
  // (t_{45} = 32.7764 + 10410.9(e^{8.17e-6 × 47} - 1) = 36.78 min)". Each bullet names
  // its column by a unit-stripped near-token prefix (T_at_20min / t_to_45c) and omits
  // the index — "For batch 47:" is stated once at the top. The shared block index (47)
  // pairs with each bullet's own (col, form) binding. Hand-verified: linear(47)=58.016,
  // exponential(47)=36.775; both claims pass.
  const answer = loadAnswer("thermal-t1-latex-derivation");
  const res = recheckAnswer(thermal, answer);
  const preds = res.claims.filter((c) => c.kind === "model-prediction");

  test("extracts exactly two model predictions, both passing", () => {
    expect(res.checked).toBe(2);
    expect(res.flags).toBe(0);
    expect(preds.length).toBe(2);
    for (const c of preds) expect(c.verdict).toBe("pass");
  });

  test("the linear T_at_20min_c prediction binds via near-token and recomputes 58.016", () => {
    const lin = preds.find((c) => c.recomputed.includes("T_at_20min_c"));
    expect(lin).toBeDefined();
    expect(lin?.recomputed).toContain("linear(47)");
    expect(lin?.recomputed).toContain("58.016");
    expect(lin?.verdict).toBe("pass");
  });

  test("the exponential t_to_45c_min prediction binds and recomputes 36.775", () => {
    const exp = preds.find((c) => c.recomputed.includes("t_to_45c_min"));
    expect(exp).toBeDefined();
    expect(exp?.recomputed).toContain("exponential(47)");
    expect(exp?.recomputed).toContain("36.775");
    expect(exp?.verdict).toBe("pass");
  });

  test("mutation: 58.02 → 52.0 flags exactly the linear claim, exponential still passes", () => {
    const mutated = recheckAnswer(thermal, answer.replace("58.02", "52.0"));
    const mPreds = mutated.claims.filter((c) => c.kind === "model-prediction");
    expect(mutated.flags).toBe(1);
    expect(mPreds.length).toBe(2);
    const flagged = mPreds.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].recomputed).toContain("T_at_20min_c");
    expect(flagged[0].recomputed).toContain("linear(47)");
    const exp = mPreds.find((c) => c.recomputed.includes("t_to_45c_min"));
    expect(exp?.verdict).toBe("pass");
  });
});

describe("thermal T2 latex-derivation — near-token with spaced/superscript literals", () => {
  // Production lens+pack answer (gate-calibration, ans-thermal-T2__lenspack). This
  // question is about t_to_45c only (batch 92). The exponential prediction is restated
  // in two bullets: one carrying the step-by-step "tto45c(92) ≈ ... ≈ 40.60 min", one
  // the "Total span = tto45c / x(45 °C) ≈ 40.60 min / 0.6125" scaling. The literals use
  // a thousands SPACE separator (10 410.9) and unicode superscript (×10⁻⁶), so the form
  // cannot bind by formula; the near-token "tto45c" + "exponential" binds it instead.
  // Hand-verified: exponential(92) = 40.605; both restatements (40.60 min) pass.
  const NB = " "; // narrow no-break space between value and unit in the live answer
  const answer = loadAnswer("thermal-t2-latex-derivation");
  const res = recheckAnswer(thermal, answer);
  const preds = res.claims.filter((c) => c.kind === "model-prediction");

  test("extracts the t_to_45c_min predictions, all passing, none flagged", () => {
    expect(res.flags).toBe(0);
    expect(preds.length).toBe(2);
    for (const c of preds) {
      expect(c.verdict).toBe("pass");
      expect(c.recomputed).toContain("t_to_45c_min");
      expect(c.recomputed).toContain("exponential(92)");
      expect(c.recomputed).toContain("40.605");
    }
  });

  test("mutation: 40.60 min → 44.20 min flags both restatements (arithmetic, not text)", () => {
    const mutated = recheckAnswer(thermal, answer.replaceAll(`40.60${NB}min`, `44.20${NB}min`));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(2);
    for (const c of flagged) expect(c.kind).toBe("model-prediction");
  });
});

describe("battery C ratio-window — multi-line derived-ratio grounding", () => {
  // Production lens+pack answer (gate-calibration, ans-battery-C__lenspack). The two
  // operands sit on earlier lines with their index + unit ("Cycle 1 discharge capacity:
  // 1.8565 Ah ... Cycle 100 ... 1.4859 Ah"); a later line gives the bare ratio + percent
  // ("1.4859 / 1.8565 ≈ 0.8004, or 80.0 %") with no unit and no index of its own. The
  // window join grounds each operand against the dataset (capacity_ah@1=1.8565,
  // @100=1.4859) and compares the grounded ratio (80.04%) to the claim. Both correct → pass.
  const NB = " "; // narrow no-break space used between the value and %
  const answer = loadAnswer("battery-c-ratio-window");
  const res = recheckAnswer(battery, answer);

  test("extracts exactly one derived-ratio claim, passing", () => {
    expect(res.checked).toBe(1);
    expect(res.flags).toBe(0);
    const dr = res.claims.filter((c) => c.kind === "derived-ratio");
    expect(dr.length).toBe(1);
    expect(dr[0].verdict).toBe("pass");
    expect(dr[0].recomputed).toContain("80.038%");
    expect(dr[0].recomputed).toContain("matches 80%");
  });

  test("mutation: 80.0 % → 65 % flags the grounded ratio (arithmetic, not text)", () => {
    const mutated = recheckAnswer(battery, answer.replace(`80.0${NB}%`, `65${NB}%`));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(mutated.flags).toBe(1);
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("derived-ratio");
    expect(flagged[0].recomputed).toContain("vs claimed 65%");
  });

  test("mutation: 1.4859 → 1.6 (ungroundable operand) extracts nothing, never flags", () => {
    const mutated = recheckAnswer(battery, answer.replaceAll("1.4859", "1.6"));
    expect(mutated.checked).toBe(0);
    expect(mutated.flags).toBe(0);
    expect(mutated.claims.length).toBe(0);
  });
});

describe("battery C ratio-window 2 — percentage and ratio split across paragraphs", () => {
  // Production pack-only answer (gate-calibration, ans-battery-C__packonly). The index +
  // value statements ("At cycle 1 ... 1.8565 Ah; at cycle 100 it is 1.4859 Ah"), the bare
  // ratio ("1.4859 ÷ 1.8565 ≈ 0.80027"), and the percentage ("so roughly 80.0% ...") sit
  // in THREE separate paragraphs. The flattened-sentence window join spans the paragraph
  // breaks, grounds both operands against the dataset, and the grounded ratio passes.
  const answer = loadAnswer("battery-c-ratio-window-2");
  const res = recheckAnswer(battery, answer);

  test("extracts exactly one derived-ratio claim, passing", () => {
    expect(res.checked).toBe(1);
    expect(res.flags).toBe(0);
    const dr = res.claims.filter((c) => c.kind === "derived-ratio");
    expect(dr.length).toBe(1);
    expect(dr[0].verdict).toBe("pass");
    expect(dr[0].recomputed).toContain("80.038%");
  });

  test("mutation: 80.0% → 65% flags the grounded ratio", () => {
    const mutated = recheckAnswer(battery, answer.replace("80.0%", "65%"));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(mutated.flags).toBe(1);
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("derived-ratio");
    expect(flagged[0].recomputed).toContain("vs claimed 65%");
  });

  test("mutation: 1.4859 → 1.6 (ungroundable) extracts nothing", () => {
    const mutated = recheckAnswer(battery, answer.replaceAll("1.4859", "1.6"));
    expect(mutated.checked).toBe(0);
    expect(mutated.flags).toBe(0);
  });
});

describe("battery U2 delta-quote — derived Δ never a constant, MAE mV converts", () => {
  // Production lens+pack answer (gate-calibration, ans-battery-U2__lenspack). One
  // parenthetical aside binds v_at_1800s + sqrt_linear and states three TRUE numbers:
  // a derived "Δv_at_1800s ≈ −0.107 V" (model difference f(110)−f(1) = −0.1068) and the
  // fit/val MAEs quoted in millivolts ("≈ 4 mV", "≈ 6.6 mV"). Stored sqrt_linear MAEs
  // are 0.003893 V (3.89 mV) and 0.006594 V (6.59 mV). Two prior defects: (1) the mV
  // quotes were compared as 4 / 6.6 against ~0.004 V → false flag; (2) a Δ-marked
  // difference is not a stored constant and must never be a constant-quote candidate.
  // Fix: milli-unit scaling on the MAE quote + a delta-mark guard. The notes-constant
  // ("discharged ... at 2.0 A", matching CC discharge 2.0 A in notes) passes unchanged.
  const answer = loadAnswer("battery-u2-delta-quote");
  const res = recheckAnswer(battery, answer);

  test("zero flags", () => {
    expect(res.flags).toBe(0);
  });

  test("exactly two claims checked: notes-constant pass + MAE constant-quote pass", () => {
    expect(res.checked).toBe(2);
    expect(res.claims.length).toBe(2);
    for (const c of res.claims) expect(c.verdict).toBe("pass");
  });

  test("the notes-constant 2.0 A discharge claim passes", () => {
    const nc = res.claims.find((c) => c.kind === "notes-constant");
    expect(nc).toBeDefined();
    expect(nc?.verdict).toBe("pass");
  });

  test("the MAE quote binds v_at_1800s sqrt_linear and passes after mV→V conversion", () => {
    const cq = res.claims.find((c) => c.kind === "constant-quote");
    expect(cq).toBeDefined();
    expect(cq?.verdict).toBe("pass");
    expect(cq?.recomputed).toContain("v_at_1800s sqrt_linear");
  });

  test("no derived-ratio or model-prediction is fabricated from the Δ −0.107 V quantity", () => {
    const spurious = res.claims.filter(
      (c) => c.kind === "derived-ratio" || c.kind === "model-prediction"
    );
    expect(spurious.length).toBe(0);
  });

  // Δ-recompute was DECLINED (both table indices cannot be bound to the parenthetical
  // unambiguously): the Δ quantity is never extracted, so mutating its value cannot
  // flag. The mutation proves the Δ is genuinely not a checked candidate AND that the
  // MAE quotes' pass behavior is unchanged by the edit.
  test("mutation: −0.107 V → −0.25 V keeps 0 flags; the MAE constant-quote still passes", () => {
    const mutated = recheckAnswer(battery, answer.replace("0.107", "0.25"));
    expect(mutated.flags).toBe(0);
    expect(mutated.checked).toBe(2);
    const cq = mutated.claims.find((c) => c.kind === "constant-quote");
    expect(cq).toBeDefined();
    expect(cq?.verdict).toBe("pass");
    expect(cq?.recomputed).toContain("v_at_1800s sqrt_linear");
  });
});

describe("thermal T3 two-formula — genuinely ambiguous, correctly declined", () => {
  // Production lens+pack answer (gate-calibration, ans-thermal-T3__lenspack). ONE
  // sentence states BOTH thermal column formulas: "predicted temperature ... is 59.22
  // °C (linear model: 55.8401 − (−0.0463002)·73) and the predicted time to cool to 45 °C
  // is 38.99 min (exponential model: 32.7764 − (−10410.9)·(e^(8.17026e−06·73) − 1))".
  // Both values are TRUE, but each value PRECEDES its parenthetical formula with no
  // trailing "= value" — the value does not terminate the same math expression as the
  // formula, so expression-local pairing does not apply. Item-2 extraction was DECLINED:
  // the two-column ambiguity guard correctly leaves this sentence unextracted rather
  // than risk a mis-bind. (Contrast thermal-t1-latex-derivation, where each formula is a
  // proper "T_{20} = <formula> = 58.02 °C" chain and both DO extract.)
  const answer = loadAnswer("thermal-t3-two-formula");
  const res = recheckAnswer(thermal, answer);

  test("nothing extracted — checked 0, flags 0", () => {
    expect(res.checked).toBe(0);
    expect(res.flags).toBe(0);
    expect(res.claims).toEqual([]);
  });
});

describe("thermal T4 latex-units — LaTeX degree macro normalizes, prediction binds", () => {
  // Production lens+pack answer (gate-calibration, ans-thermal-T4__lenspack). The
  // single prediction is wrapped in LaTeX degree markup:
  //   "T_{\text{at20}}(18) = 55.8401 + 0.0463002 \times 18 \approx 56.674\;^{\circ}\text{C}".
  // The "\;^{\circ}\text{C}" rendered "56.674 ^{circ}C" after the old normalize, wedging
  // "^{circ}" between the value and its unit letter so the value↔unit adjacency broke and
  // valuesWithUnit(°C) never matched — checked 0. Fix: normalize "^{\circ}"/"\degree" → "°"
  // before the backslash strip. The formula literals bind (T_at_20min_c, linear); "(18)"
  // and "batch 18" give the index. Hand-verified linear(18) = 56.673; claim 56.674 passes.
  // The shape-table interpolation lines below (span fractions, 71.7 °C final) are not
  // pack-recomputable claim families and must stay unextracted (no index ref of their own).
  const answer = loadAnswer("thermal-t4-latex-units");
  const res = recheckAnswer(thermal, answer);
  const preds = res.claims.filter((c) => c.kind === "model-prediction");

  test("extracts exactly one model-prediction, passing", () => {
    expect(res.checked).toBe(1);
    expect(res.flags).toBe(0);
    expect(preds.length).toBe(1);
    expect(preds[0].verdict).toBe("pass");
    expect(preds[0].recomputed).toContain("linear(18)");
    expect(preds[0].recomputed).toContain("56.673");
    expect(preds[0].recomputed).toContain("T_at_20min_c");
  });

  test("the 71.7 °C shape-table interpolation is NOT extracted", () => {
    const interp = res.claims.filter((c) => c.claim.includes("71.7"));
    expect(interp.length).toBe(0);
  });

  test("mutation: 56.674 → 50.6 yields exactly 1 flag (arithmetic, not text)", () => {
    const mutated = recheckAnswer(thermal, answer.replace("56.674", "50.6"));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(mutated.flags).toBe(1);
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
    expect(flagged[0].recomputed).toContain("linear(18)");
  });
});

describe("thermal T5 clause-pairs — two-column clause-paired prediction, paragraph index", () => {
  // Production lens+pack answer (gate-calibration, ans-thermal-T5__lenspack). ONE sentence
  // states predictions for BOTH thermal columns in parallel clauses, with the index named
  // in the PRIOR sentence ("Batch 104 ..."):
  //   "...: for time-to-45 °C the exponential trend gives 41.63 min, and for
  //    temperature-at-20 min the linear trend gives 60.66 °C."
  // The single-column synonym path can't bind it — the sentence carries BOTH a °C and a min
  // value, so it is unit-ambiguous as a whole. The clause-paired mechanism splits on the
  // connectives, binds each clause by its CLAIMED VALUE's unit (41.63 min → t_to_45c_min,
  // 60.66 °C → T_at_20min_c) — never by the °C/min units inside the prose names
  // ("time-to-45 °C") — and borrows the index 104 from the paragraph. Hand-verified:
  // exponential(104) = 41.626 and linear(104) = 60.655; both clauses pass.
  const answer = loadAnswer("thermal-t5-clause-pairs");
  const res = recheckAnswer(thermal, answer);
  const preds = res.claims.filter((c) => c.kind === "model-prediction");

  test("extracts exactly two model predictions, both passing", () => {
    expect(res.checked).toBe(2);
    expect(res.flags).toBe(0);
    expect(preds.length).toBe(2);
    for (const c of preds) expect(c.verdict).toBe("pass");
  });

  test("the min clause binds t_to_45c_min exponential at batch 104 (41.626)", () => {
    const exp = preds.find((c) => c.recomputed.includes("t_to_45c_min"));
    expect(exp).toBeDefined();
    expect(exp?.recomputed).toContain("exponential(104)");
    expect(exp?.recomputed).toContain("41.626");
    expect(exp?.verdict).toBe("pass");
  });

  test("the °C clause binds T_at_20min_c linear at batch 104 (60.655)", () => {
    const lin = preds.find((c) => c.recomputed.includes("T_at_20min_c"));
    expect(lin).toBeDefined();
    expect(lin?.recomputed).toContain("linear(104)");
    expect(lin?.recomputed).toContain("60.655");
    expect(lin?.verdict).toBe("pass");
  });

  test("the shape-table interpolation paragraph (20.69 min) is NOT extracted", () => {
    const interp = res.claims.filter((c) => /20\.69|0\.69 min|21\.63/.test(c.claim));
    expect(interp.length).toBe(0);
  });

  test("mutation: 41.63 → 24.7 flags exactly the exponential clause; the 60.66 claim still passes", () => {
    const mutated = recheckAnswer(thermal, answer.replace("41.63", "24.7"));
    const mPreds = mutated.claims.filter((c) => c.kind === "model-prediction");
    expect(mutated.flags).toBe(1);
    expect(mPreds.length).toBe(2);
    const flagged = mPreds.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].recomputed).toContain("exponential(104)");
    const lin = mPreds.find((c) => c.recomputed.includes("T_at_20min_c"));
    expect(lin?.verdict).toBe("pass");
  });
});

describe("thermal U1 difference-claim — two-index difference is not a point prediction", () => {
  // Production lens+pack answer (gate-calibration, ans-thermal-U1__lenspack). The
  // sentence "Plugging in (k=15) and (k=95) yields the 6.8 min difference;" carries TWO
  // index refs AND a difference cue ("difference"), so the 6.8 min value is the model-
  // prediction DIFFERENCE |f(95) − f(15)|, NOT a point prediction at either index. The
  // old model-prediction path treated 6.8 as a point value at k=15 AND k=95 and flagged
  // both (recomputed 34.052 and 40.860) — two false positives. Hand-verified TRUE:
  // exponential(95) − exponential(15) = 40.860 − 34.052 = 6.808 ≈ 6.8. Difference-
  // recompute IMPLEMENTED: the value is recomputed as |f(K2) − f(K1)| of the bound
  // exponential form (same flag tolerance as point predictions), so a fabricated
  // difference still flags while the true 6.8 min passes.
  const NB = " "; // narrow no-break space (U+202F) between value and "min" in the live answer
  const answer = loadAnswer("thermal-u1-difference-claim");
  const res = recheckAnswer(thermal, answer);

  test("zero flags for the whole answer", () => {
    expect(res.flags).toBe(0);
  });

  test("exactly one claim checked: the difference-recompute, passing", () => {
    expect(res.checked).toBe(1);
    expect(res.claims.length).toBe(1);
    expect(res.claims[0].kind).toBe("model-prediction");
    expect(res.claims[0].verdict).toBe("pass");
    expect(res.claims[0].recomputed).toBe(
      "exponential(95) - exponential(15) = 6.808 for t_to_45c_min"
    );
  });

  test("no point-prediction at k=15 or k=95 is ever extracted from the difference value", () => {
    const pointPreds = res.claims.filter(
      (c) => c.kind === "model-prediction" && /^exponential\(\d+\) =/.test(c.recomputed)
    );
    expect(pointPreds.length).toBe(0);
  });

  test("mutation: '6.8 min' → '25 min' yields exactly 1 flag (difference arithmetic, not text)", () => {
    // 25 is clearly not the true difference (6.808) and not an index value, so it flags.
    // (The literal example '15' collides with index k=15 — the index-collision guard
    // excludes it and extracts nothing, never a false flag — so 25 is used here.)
    const mutated = recheckAnswer(thermal, answer.replace(`6.8${NB}min difference`, `25${NB}min difference`));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(mutated.flags).toBe(1);
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
    expect(flagged[0].recomputed).toBe(
      "exponential(95) - exponential(15) = 6.808 for t_to_45c_min"
    );
  });

  test("mutation within tolerance: '6.8 min' → '6.84 min' still passes (arithmetic, not text)", () => {
    const mutated = recheckAnswer(thermal, answer.replace(`6.8${NB}min difference`, `6.84${NB}min difference`));
    expect(mutated.flags).toBe(0);
    expect(mutated.checked).toBe(1);
  });
});

describe("thermal A sign-trap — headline prediction in the spelled-out-unit register", () => {
  // Production answers (gate-calibration, ans-thermal-A__lenspack / __packonly). Both
  // walk the exponential form step-by-step in display math and headline the result as
  // "Predicted time to 45 °C for batch 95 = 40.86 min(utes)". Two coverage gaps closed:
  //   (lens+pack) the unit is spelled out ("40.86 minutes") — unit-word normalization
  //     rewrites it to "40.86 min" so the carried (col, form) binding pairs it;
  //   (both) the bold final line names the column by prose ("time to 45 °C", not the
  //     t_to_45c_min token) and uses the past-tense cue "Predicted" — the carried
  //     headline-prediction path binds it via unit-unique noun + cue + single index.
  // Hand-verified: exponential(95) = 40.860 min (correct → PASS). A sign-error answer
  // (dropping the double negative on b = -10410.9) concludes ≈ 24.69 min → must FLAG.
  const lenspack = loadAnswer("thermal-a-sign-trap");
  const packonly = loadAnswer("thermal-a-sign-trap-2");

  for (const [label, answer] of [["lens+pack", lenspack], ["pack-only", packonly]] as const) {
    test(`${label}: extracts the 40.86 min prediction as model-prediction, passing`, () => {
      const res = recheckAnswer(thermal, answer);
      const preds = res.claims.filter((c) => c.kind === "model-prediction");
      expect(preds.length).toBe(1);
      expect(preds[0].verdict).toBe("pass");
      expect(preds[0].recomputed).toContain("exponential(95)");
      expect(preds[0].recomputed).toContain("t_to_45c_min");
      expect(preds[0].recomputed).toContain("40.86");
    });

    test(`${label}: zero flags on the correct answer (MAE quote never flags)`, () => {
      const res = recheckAnswer(thermal, answer);
      const flagged = res.claims.filter((c) => c.verdict === "flag");
      if (flagged.length > 0) {
        throw new Error(`${label} false-positives:\n` + flagged.map((c) => `  [${c.kind}] ${c.claim}\n    => ${c.recomputed}`).join("\n"));
      }
      expect(res.flags).toBe(0);
    });

    test(`${label}: mutation 40.86 → 24.69 (sign error) yields exactly 1 flag`, () => {
      const mutated = recheckAnswer(thermal, answer.replaceAll("40.86", "24.69"));
      const flagged = mutated.claims.filter((c) => c.verdict === "flag");
      expect(mutated.flags).toBe(1);
      expect(flagged.length).toBe(1);
      expect(flagged[0].kind).toBe("model-prediction");
      expect(flagged[0].recomputed).toContain("exponential(95)");
      expect(flagged[0].recomputed).toContain("40.86");
    });
  }

  test("the validation-MAE quote (± 0.29 min) is never extracted as a prediction", () => {
    for (const answer of [lenspack, packonly]) {
      const res = recheckAnswer(thermal, answer);
      const mae = res.claims.filter(
        (c) => c.kind === "model-prediction" && /0\.29/.test(c.claim) && /0\.29/.test(c.recomputed)
      );
      expect(mae.length).toBe(0);
    }
  });
});

describe("thermal U2 window-drop — per-index derived-quantity list must not point-predict", () => {
  // Production pack-only answer (gate-calibration, ans-thermal-U2__packonly). The sentence
  // "...the drop is ≈ 4.4 °C (batch 1) and ≈ 4.2 °C (batch 110)." pairs each value with its
  // own parenthesized index, but the quantity is a derived WITHIN-WINDOW temperature drop
  // (minute 20 → minute 25), NOT the bound column T_at_20min_c's point value. The old point-
  // prediction path bound the carried (T_at_20min_c, linear) and compared 4.4 against
  // linear(1)=55.886 and 4.2 against linear(110)=60.933 — two false flags on a TRUE claim
  // (hand-verified within-batch cooling drops: batch 1 ≈ 4.41 °C, batch 110 ≈ 4.20 °C).
  // Recomputing window drops is OUT OF SCOPE (new claim family) → the per-index derived-
  // quantity list extracts NOTHING. The two genuine point predictions (linear(75)=59.313
  // near "batch 75"; linear(70)=59.081 "before batch 70") must keep extracting and passing.
  const answer = loadAnswer("thermal-u2-window-drop");
  const res = recheckAnswer(thermal, answer);

  test("zero flags for the whole answer", () => {
    expect(res.flags).toBe(0);
  });

  test("the derived-quantity drop list is never extracted (no claim from the 4.4/4.2 values)", () => {
    const dropClaims = res.claims.filter((c) => c.claim.includes("the drop is"));
    expect(dropClaims.length).toBe(0);
  });

  test("exactly the two point predictions are checked, both passing (linear(75), linear(70))", () => {
    expect(res.checked).toBe(2);
    const preds = res.claims.filter((c) => c.kind === "model-prediction");
    expect(preds.length).toBe(2);
    for (const c of preds) expect(c.verdict).toBe("pass");
    const at75 = preds.find((c) => c.recomputed.includes("linear(75)"));
    const at70 = preds.find((c) => c.recomputed.includes("linear(70)"));
    expect(at75?.recomputed).toContain("59.313");
    expect(at75?.recomputed).toContain("T_at_20min_c");
    expect(at70?.recomputed).toContain("59.081");
  });

  test("mutation: 'critical 59 °C' → 'critical 70 °C' flags exactly the batch-75 claim (arithmetic, not text)", () => {
    // The batch-75 point prediction pairs the threshold value (59 °C) against linear(75)=
    // 59.313 (passes). Mutating the claimed value to 70 °C makes |70 − 59.313| exceed
    // tolerance → flag; the batch-70 claim is in a different sentence and still passes.
    expect(answer.includes("critical 59")).toBe(true);
    const mutated = recheckAnswer(thermal, answer.replace("critical 59", "critical 70"));
    const mPreds = mutated.claims.filter((c) => c.kind === "model-prediction");
    expect(mutated.flags).toBe(1);
    expect(mPreds.length).toBe(2);
    const flagged = mPreds.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].recomputed).toContain("linear(75)");
    const at70 = mPreds.find((c) => c.recomputed.includes("linear(70)"));
    expect(at70?.verdict).toBe("pass");
  });
});

describe("thermal U3 campaign-mean — aggregate over a range is recomputed, not point-predicted", () => {
  // Production pack-only answer (gate-calibration, ans-thermal-U3__packonly). The bullet
  // "- Campaign average (arithmetic mean of predictions for k = 1…110): ≈ 37.5 min" states
  // the arithmetic MEAN of the bound form over the range 1..110, not a point value at any
  // single index. The old path read "k = 1…110" as an index ref at k=1 and compared 37.5
  // against linear(1)=32.861 — one false flag on a TRUE claim (hand-verified: mean of the
  // linear t_to_45c_min over k=1..110 = 37.499 ≈ 37.5). AGGREGATE RECOMPUTE implemented:
  // the value is recomputed as the arithmetic mean of the bound form over the integer range
  // and flagged iff outside the standard point tolerance. The two point predictions
  // ("Batch 1 predicted: 32.86 min", "Batch 110 predicted: 42.14 min") keep passing.
  const NB = String.fromCharCode(0x202f); // narrow no-break space around the 37.5 min value
  const answer = loadAnswer("thermal-u3-campaign-mean");
  const res = recheckAnswer(thermal, answer);

  test("zero flags for the whole answer", () => {
    expect(res.flags).toBe(0);
  });

  test("the campaign-average bullet passes via the aggregate recompute (mean linear(1..110) = 37.499)", () => {
    const agg = res.claims.filter((c) => /^mean linear\(1\.\.110\) =/.test(c.recomputed));
    expect(agg.length).toBe(1);
    expect(agg[0].kind).toBe("model-prediction");
    expect(agg[0].verdict).toBe("pass");
    expect(agg[0].recomputed).toBe("mean linear(1..110) = 37.499 for t_to_45c_min");
  });

  test("no point prediction at a single index is fabricated from the aggregate value", () => {
    const pointFromAgg = res.claims.filter(
      (c) => c.claim.includes("Campaign average") && /^linear\(\d+\) =/.test(c.recomputed)
    );
    expect(pointFromAgg.length).toBe(0);
  });

  test("the two genuine point predictions still pass (linear(1)=32.861, linear(110)=42.136)", () => {
    const preds = res.claims.filter(
      (c) => c.kind === "model-prediction" && /^linear\(\d+\) =/.test(c.recomputed)
    );
    expect(preds.length).toBe(2);
    for (const c of preds) expect(c.verdict).toBe("pass");
    expect(preds.find((c) => c.recomputed.includes("linear(1)"))?.recomputed).toContain("32.861");
    expect(preds.find((c) => c.recomputed.includes("linear(110)"))?.recomputed).toContain("42.136");
  });

  test("mutation: '37.5 min' → '45 min' flags exactly the aggregate (arithmetic, not text)", () => {
    const mutated = recheckAnswer(thermal, answer.replace(`${NB}37.5${NB}min`, `${NB}45${NB}min`));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(mutated.flags).toBe(1);
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
    expect(flagged[0].recomputed).toBe("mean linear(1..110) = 37.499 for t_to_45c_min");
  });
});

describe("thermal B sign-flip pack-only — true-positive sign error must keep flagging", () => {
  // Production pack-only answer (gate-calibration, ans-thermal-B__packonly): "The linear
  // model predicts a T_at_20min_c of 51.12 °C for batch 102, and its held-out validation
  // MAE is 0.2005 °C." The 51.12 °C is a sign-error fabrication — the stored linear fit
  // gives 60.563 °C at batch 102 (a dropped minus on b). This must remain a flag (a TRUE
  // positive found today); the FP-class fixes must not regress it. The MAE quote (0.2005 °C,
  // matching stored val_mae) passes.
  const answer = loadAnswer("thermal-b-sign-flip");
  const res = recheckAnswer(thermal, answer);

  test("exactly 1 flag: the sign-error model-prediction (51.12 vs linear(102)=60.563)", () => {
    expect(res.flags).toBe(1);
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
    expect(flagged[0].claim).toContain("51.12");
    expect(flagged[0].recomputed).toContain("linear(102)");
    expect(flagged[0].recomputed).toContain("60.563");
  });

  test("the validation-MAE constant-quote passes", () => {
    const cq = res.claims.find((c) => c.kind === "constant-quote");
    expect(cq?.verdict).toBe("pass");
  });

  test("mutation: 51.12 → 60.56 (corrected) yields 0 flags (the flag is arithmetic, not text)", () => {
    const corrected = recheckAnswer(thermal, answer.replace("51.12", "60.56"));
    expect(corrected.flags).toBe(0);
  });
});

describe("thermal C fabricated-inputs pack-only — true-positive derived-ratio must keep flagging", () => {
  // Production pack-only answer (gate-calibration, ans-thermal-C__packonly). The sentence
  // "...gives 32.7 min for batch 10 ... and 42.3 min for batch 105, yielding about 77.3 %..."
  // claims a 77.3% figure derived from values at two cited indices. At batch 10 the grounded
  // ratio cannot reach 77.3% (the model value there is 33.4 min, so X/v=126.6%, 1−X/v=−26.6%
  // — neither within 3pp of 77.3%) → that index flags (a TRUE positive). The batch-105 index
  // grounds correctly (42.3/41.9 ≈ 101%, or the complement near 77.3%) and passes. The FP-
  // class fixes must not regress this flag.
  const answer = loadAnswer("thermal-c-fabricated-inputs");
  const res = recheckAnswer(thermal, answer);

  test("exactly 1 flag: the derived-ratio at batch 10 (77.3% ungroundable there)", () => {
    expect(res.flags).toBe(1);
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("derived-ratio");
    expect(flagged[0].recomputed).toContain("cycle 10");
    expect(flagged[0].recomputed).toContain("vs claimed 77.3%");
  });

  test("the batch-1/batch-110 point predictions pass (parsing sanity)", () => {
    const preds = res.claims.filter((c) => c.kind === "model-prediction" && c.verdict === "pass");
    expect(preds.length).toBeGreaterThanOrEqual(2);
  });

  test("mutation: 77.3 → 101.0 (the true model value) clears the flag (arithmetic, not text)", () => {
    const corrected = recheckAnswer(thermal, answer.replaceAll("77.3", "101.0"));
    expect(corrected.flags).toBe(0);
  });
});

// ── execution-trace probe pack: nlogn + quadratic fitted forms ──────────────────
// Real pack artifacts (fixtures/recheck/exec-trace/). Sort comparison-count
// trends over input size n; two NEW fitted forms (nlogn, quadratic) alongside the
// existing linear/sqrt_linear/exponential, same y = a − b·g(k) sign convention.
// Recomputed values (via the same evalForm the builder mirrors, build_pack.py):
//   cmp_quicksort nlogn  [44.251073737895545, -1.2100340437887258] @ n=6144 → 93606.515
//   cmp_quicksort linear [-1152.8661126500472, -14.065416007123071] @ n=6144 → 85265.050
//   cmp_insertion quadratic [-3074.305387689499, -0.2533932129127634] @ n=4096 → 4248158.361
const EXEC_PACK_DIR = join(FIX, "exec-trace");
function loadExecTracePack(): PackArtifacts {
  const params = readFileSync(join(EXEC_PACK_DIR, "pack_params.json"), "utf-8");
  const obj = JSON.parse(params) as { spec?: { columns?: unknown } };
  return {
    paramsJson: params,
    datasetCsv: readFileSync(join(EXEC_PACK_DIR, "dataset.csv"), "utf-8"),
    columnSpec: JSON.stringify(obj.spec?.columns ?? {}),
    notes: "",
  };
}
const execTrace = loadExecTracePack();

describe("exec-trace (a) nlogn prediction — PASS", () => {
  // 93,606 (thousands comma) is within tol of the recompute 93606.515.
  const ans =
    "Using the cmp_quicksort nlogn model at n = 6144, the model yields about 93,606 comparisons.";
  const res = recheckAnswer(execTrace, ans);

  test("checked ≥ 1, 0 flags, model-prediction kind", () => {
    expect(res.checked).toBeGreaterThanOrEqual(1);
    expect(res.flags).toBe(0);
    const preds = res.claims.filter((c) => c.kind === "model-prediction");
    expect(preds.length).toBe(1);
    expect(preds[0].verdict).toBe("pass");
    expect(preds[0].recomputed).toContain("nlogn(6144)");
    expect(preds[0].recomputed).toContain("93606");
  });

  test("MUTATION: value bumped past tolerance (96,000) flags", () => {
    const mutated = recheckAnswer(execTrace, ans.replace("93,606", "96,000"));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
  });
});

describe("exec-trace (b) fidelity vs accuracy — same value, two named forms", () => {
  // The linear-form value (85,265 ≈ 85265.050) at n=6144 is ~8.9% off the nlogn recompute
  // — inside MISEXTRACT_WINDOW (25%), beyond REL_PREDICTION (1.5%). Naming nlogn flags it
  // (unfaithful to the named form); naming linear passes (faithful to ITS form). Both
  // assertions are required: this is the fidelity-vs-accuracy separation.
  const linearValueNamedNlogn =
    "Using the cmp_quicksort nlogn model at n = 6144, the model yields about 85,265 comparisons.";
  const linearValueNamedLinear =
    "Using the cmp_quicksort linear model at n = 6144, the model yields about 85,265 comparisons.";

  test("naming nlogn → FLAG (value belongs to linear form)", () => {
    const res = recheckAnswer(execTrace, linearValueNamedNlogn);
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
    expect(flagged[0].recomputed).toContain("nlogn(6144)");
    expect(flagged[0].recomputed).toContain("93606");
  });

  test("naming linear → PASS (claim faithful to ITS named form)", () => {
    const res = recheckAnswer(execTrace, linearValueNamedLinear);
    expect(res.flags).toBe(0);
    const preds = res.claims.filter((c) => c.kind === "model-prediction");
    expect(preds.length).toBe(1);
    expect(preds[0].verdict).toBe("pass");
    expect(preds[0].recomputed).toContain("linear(6144)");
    expect(preds[0].recomputed).toContain("85265");
  });

  test("MUTATION: nlogn-named with the CORRECT nlogn value (93,606) clears the flag", () => {
    const res = recheckAnswer(execTrace, linearValueNamedNlogn.replace("85,265", "93,606"));
    expect(res.flags).toBe(0);
  });
});

describe("exec-trace (c) quadratic prediction — PASS", () => {
  // cmp_insertion quadratic @ n=4096 → 4248158.361; "4,248,158" with thousands commas.
  const ans =
    "For cmp_insertion the quadratic model at n = 4096 yields about 4,248,158 comparisons.";
  const res = recheckAnswer(execTrace, ans);

  test("checked ≥ 1, 0 flags", () => {
    expect(res.checked).toBeGreaterThanOrEqual(1);
    expect(res.flags).toBe(0);
    const preds = res.claims.filter((c) => c.kind === "model-prediction");
    expect(preds.length).toBe(1);
    expect(preds[0].verdict).toBe("pass");
    expect(preds[0].recomputed).toContain("quadratic(4096)");
    expect(preds[0].recomputed).toContain("4248158");
  });

  test("MUTATION: value off by >tolerance (4,400,000, ~3.6%) flags", () => {
    const mutated = recheckAnswer(execTrace, ans.replace("4,248,158", "4,400,000"));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
  });
});

describe("exec-trace (d) formInProse — log-linear/n log n bind nlogn; quadratic binds quadratic", () => {
  test("'the n log n model' binds nlogn (not linear)", () => {
    const ans = "Using the n log n model for cmp_quicksort at n = 6144, expect about 93,606 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    const preds = res.claims.filter((c) => c.kind === "model-prediction");
    expect(preds.length).toBe(1);
    expect(preds[0].recomputed).toContain("nlogn(6144)");
    expect(preds[0].verdict).toBe("pass");
  });

  test("'log-linear' binds nlogn (not linear)", () => {
    const ans = "The log-linear cmp_quicksort model at n = 6144 gives about 93,606 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    const preds = res.claims.filter((c) => c.kind === "model-prediction");
    expect(preds.length).toBe(1);
    expect(preds[0].recomputed).toContain("nlogn(6144)");
    expect(preds[0].verdict).toBe("pass");
  });

  test("MUTATION: log-linear binding catches a linear-form value as a flag", () => {
    // If "log-linear" mistakenly bound `linear`, 85,265 would PASS. It must bind nlogn and FLAG.
    const ans = "The log-linear cmp_quicksort model at n = 6144 gives about 85,265 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].recomputed).toContain("nlogn(6144)");
  });

  test("'quadratic' binds quadratic", () => {
    const ans = "The quadratic model for cmp_insertion at n = 4096 gives about 4,248,158 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    const preds = res.claims.filter((c) => c.kind === "model-prediction");
    expect(preds.length).toBe(1);
    expect(preds[0].recomputed).toContain("quadratic(4096)");
    expect(preds[0].verdict).toBe("pass");
  });
});

describe("exec-trace (e) constant-quote — nlogn validation MAE", () => {
  // cmp_quicksort nlogn val_mae = 885.7986747871158.
  const ans = "For cmp_quicksort the nlogn model has validation MAE 885.799 comparisons.";
  const res = recheckAnswer(execTrace, ans);

  test("binds and passes", () => {
    const cq = res.claims.filter((c) => c.kind === "constant-quote");
    expect(cq.length).toBe(1);
    expect(cq[0].verdict).toBe("pass");
    expect(cq[0].recomputed).toContain("val_mae=885.8");
  });

  test("MUTATION: timsort's MAE on the quicksort token (920.487) flags", () => {
    const mutated = recheckAnswer(execTrace, ans.replace("885.799", "920.487"));
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("constant-quote");
  });
});

describe("exec-trace (f) envelope — claim beyond max×2 extracts nothing", () => {
  // index.max = 8192, EXTRAPOLATION_FACTOR = 2 → envelope ceiling 16384. n = 20000 is outside.
  test("n = 20000 → no claim, no flag from that sentence", () => {
    const ans = "The cmp_quicksort nlogn model at n = 20000 yields about 333,000 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    expect(res.checked).toBe(0);
    expect(res.flags).toBe(0);
  });

  test("MUTATION: the SAME claim at an in-envelope n = 8192 DOES extract", () => {
    // Proves the f-case suppression is the envelope, not a parse failure.
    const ans = "The cmp_quicksort nlogn model at n = 8192 yields about 128,000 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    expect(res.checked).toBeGreaterThanOrEqual(1);
    const preds = res.claims.filter((c) => c.kind === "model-prediction");
    expect(preds.length).toBe(1);
  });
});

describe("exec-trace (g) comma normalization — '1, 234' must not bind 1234", () => {
  // The thousands-comma strip must NOT munge a comma+space list "1, 234" into "1234".
  test("a comma+space pair does not produce a bound 1234; the real prediction still binds", () => {
    const ans =
      "The cmp_quicksort nlogn model at n = 6144, after reviewing values 1, 234 here, yields about 93,606 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    const preds = res.claims.filter((c) => c.kind === "model-prediction");
    expect(preds.length).toBe(1);
    expect(preds[0].verdict).toBe("pass");
    expect(preds[0].recomputed).toContain("nlogn(6144)");
    // 1234 must never appear as the recomputed/claimed value (would mean "1, 234" was munged).
    expect(preds[0].recomputed).not.toContain("1234");
  });

  test("comma-free sentence parses identically to its comma-bearing twin", () => {
    const withComma = "Using the cmp_quicksort nlogn model at n = 6144, the model yields about 93,606 comparisons.";
    const noComma = "Using the cmp_quicksort nlogn model at n = 6144, the model yields about 93606 comparisons.";
    const a = recheckAnswer(execTrace, withComma);
    const b = recheckAnswer(execTrace, noComma);
    expect(a.flags).toBe(b.flags);
    expect(a.checked).toBe(b.checked);
    expect(a.claims.map((c) => c.recomputed)).toEqual(b.claims.map((c) => c.recomputed));
    expect(a.claims.map((c) => c.verdict)).toEqual(b.claims.map((c) => c.verdict));
  });
});

// ── exec-trace probe LIVE answers — three production-formatter dialects ──────────
// Byte-exact snapshots of the three packonly answers the probe produced live
// (recorded pack-only answers T1–T3). All three are CORRECT
// answers that yielded checked=0 against this pack before the recheck-gate fixes:
//   A. LaTeX thin-space thousands separators ("16,\!777,\!216", "4,\!248,\!154.78")
//   B. space-grouped thousands ("94 973", "106 496", "94 972.92808")
//   C. the "FINAL ESTIMATE: <v> comparisons" structural summary line
// Recompute values (evalForm, mirroring build_pack.py):
//   cmp_quicksort nlogn  [44.251073737895545, -1.2100340437887258] @ n=6144 → 93606.515
//   cmp_mergesort nlogn  [-112.55842682701284, -0.8928548708344408] @ n=8192 → 94972.914
//   cmp_insertion quadratic [-3074.305387689499, -0.2533932129127634] @ n=4096 → 4248158.361

describe("exec-trace T1 (live packonly) — final-estimate rescues a structural-break summary", () => {
  // Rescued by CHANGE C (final-estimate). The body states 93606.2 with no unit; the only
  // unit-bearing value is the FINAL ESTIMATE line. nlogn(6144) = 93606.515; claimed 93606
  // passes via the 1.5% band (|0.515| « tol).
  const res = recheckAnswer(execTrace, loadAnswer("exec-trace-T1"));

  test("checked ≥ 1, 0 flags, final-estimate claim nlogn(6144) for cmp_quicksort", () => {
    expect(res.checked).toBeGreaterThanOrEqual(1);
    expect(res.flags).toBe(0);
    const fe = res.claims.filter((c) => c.kind === "final-estimate");
    expect(fe.length).toBe(1);
    expect(fe[0].verdict).toBe("pass");
    expect(fe[0].recomputed).toContain("nlogn(6144)");
    expect(fe[0].recomputed).toContain("93606");
    expect(fe[0].recomputed).toContain("cmp_quicksort");
  });

  test("MUTATION: FINAL ESTIMATE bumped past tolerance (96000) flags as final-estimate", () => {
    const mutated = recheckAnswer(
      execTrace,
      loadAnswer("exec-trace-T1").replace("FINAL ESTIMATE: 93606", "FINAL ESTIMATE: 96000")
    );
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("final-estimate");
    expect(flagged[0].recomputed).toContain("nlogn(6144)");
  });
});

describe("exec-trace T2 (live packonly) — space-grouped thousands rescue", () => {
  // Rescued by CHANGE B (space-grouped thousands). "94 973 comparisons" at n = 8192 binds a
  // model-prediction once the space is joined; the FINAL ESTIMATE line also binds. Both
  // recompute nlogn(8192) = 94972.914 (claimed 94973 / 94972.92808 — both within 1.5%).
  const res = recheckAnswer(execTrace, loadAnswer("exec-trace-T2"));

  test("checked ≥ 1, 0 flags, a model-prediction AND/OR final-estimate binds nlogn(8192)", () => {
    expect(res.checked).toBeGreaterThanOrEqual(1);
    expect(res.flags).toBe(0);
    const bound = res.claims.filter(
      (c) =>
        (c.kind === "model-prediction" || c.kind === "final-estimate") &&
        c.recomputed.includes("nlogn(8192)") &&
        c.recomputed.includes("cmp_mergesort")
    );
    expect(bound.length).toBeGreaterThanOrEqual(1);
    for (const c of bound) expect(c.verdict).toBe("pass");
    // The derivation paragraph's model-prediction must be present (the space fix is what
    // makes "94 973 comparisons" parse) — proving the rescue, not just the FINAL line.
    const mp = res.claims.filter((c) => c.kind === "model-prediction" && c.recomputed.includes("nlogn(8192)"));
    expect(mp.length).toBe(1);
    expect(mp[0].verdict).toBe("pass");
  });

  test("space-grouped thousands are joined: '94 972.92808' parses as one number", () => {
    // Sanity: the comma-bearing twin (94,972.92808 / 94,973) parses identically, proving the
    // space-join and comma-strip converge on the same literal.
    const spaced = loadAnswer("exec-trace-T2");
    const commaed = spaced
      .replace("106 496", "106,496")
      .replace("95 085.48608", "95,085.48608")
      .replace("94 972.92808", "94,972.92808")
      .replace("94 973 comparisons", "94,973 comparisons");
    const a = recheckAnswer(execTrace, spaced);
    const b = recheckAnswer(execTrace, commaed);
    expect(a.checked).toBe(b.checked);
    expect(a.flags).toBe(b.flags);
    expect(a.claims.map((c) => c.recomputed)).toEqual(b.claims.map((c) => c.recomputed));
  });
});

describe("exec-trace T3 (live packonly) — LaTeX thin-space separators + final-estimate", () => {
  // Rescued by CHANGE A (LaTeX "\!" thin-space thousands) + CHANGE C (final-estimate).
  // "16,\!777,\!216" and "4,\!248,\!154.78" must join, and the FINAL ESTIMATE line binds.
  // quadratic(4096) = 4248158.361; claimed 4248155 passes via the 1.5% band.
  const res = recheckAnswer(execTrace, loadAnswer("exec-trace-T3"));

  test("checked ≥ 1, 0 flags, final-estimate quadratic(4096) for cmp_insertion", () => {
    expect(res.checked).toBeGreaterThanOrEqual(1);
    expect(res.flags).toBe(0);
    const fe = res.claims.filter((c) => c.kind === "final-estimate");
    expect(fe.length).toBe(1);
    expect(fe[0].verdict).toBe("pass");
    expect(fe[0].recomputed).toContain("quadratic(4096)");
    expect(fe[0].recomputed).toContain("4248158");
    expect(fe[0].recomputed).toContain("cmp_insertion");
  });

  test("MUTATION: FINAL ESTIMATE off by >tolerance (4500000, ~5.9%) flags", () => {
    const mutated = recheckAnswer(
      execTrace,
      loadAnswer("exec-trace-T3").replace("FINAL ESTIMATE: 4248155", "FINAL ESTIMATE: 4500000")
    );
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("final-estimate");
    expect(flagged[0].recomputed).toContain("quadratic(4096)");
  });
});

describe("exec-trace T3 (live lenspack) — Unicode-glyph dialect binds final-estimate", () => {
  // Byte-exact snapshot of a recorded lens+pack answer (T3) — the
  // lens+pack twin of the packonly T3 above, written in the Unicode-math dialect rather
  // than LaTeX: middle dot "·" (formula "0.253393 · n²"), superscript "²", multiplication
  // sign "×" ("0.253393 × 16,777,216"), figure-dash range "64–8192", and U+2011 non-
  // breaking hyphens ("held‑out", "non‑trivial"). The prose names the form ("fitted
  // quadratic model"), so formInProse binds quadratic regardless of the "²"/"×" glyphs;
  // the only in-envelope index is n = 4096; the FINAL ESTIMATE line carries the unit.
  // quadratic(4096) = 4248158.361; claimed 4248155 passes via the 1.5% band.
  const res = recheckAnswer(execTrace, loadAnswer("exec-trace-T3-lenspack"));

  test("checked ≥ 1, 0 flags, final-estimate quadratic(4096) for cmp_insertion", () => {
    expect(res.checked).toBeGreaterThanOrEqual(1);
    expect(res.flags).toBe(0);
    const fe = res.claims.filter((c) => c.kind === "final-estimate");
    expect(fe.length).toBe(1);
    expect(fe[0].verdict).toBe("pass");
    expect(fe[0].recomputed).toContain("quadratic(4096)");
    expect(fe[0].recomputed).toContain("4248158");
    expect(fe[0].recomputed).toContain("cmp_insertion");
  });

  test("MUTATION: FINAL ESTIMATE corrupted to 4448155 (~4.7%) flags as final-estimate", () => {
    // Corrupt both the derived figure (4,248,154.8 → 4,448,154.8) and the summary line
    // (4248155 → 4448155). 4448155 is ~4.7% above the recompute 4248158.361, well past the
    // 1.5% band — proving the fixture test isn't a rubber-stamp.
    const mutated = recheckAnswer(
      execTrace,
      loadAnswer("exec-trace-T3-lenspack")
        .replace("4,248,154.8", "4,448,154.8")
        .replace("FINAL ESTIMATE: 4248155", "FINAL ESTIMATE: 4448155")
    );
    const flagged = mutated.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("final-estimate");
    expect(flagged[0].recomputed).toContain("quadratic(4096)");
  });
});

describe("exec-trace final-estimate — high-precision guards (mutation twins)", () => {
  // (a) the sign-error / wrong-form fabrication class: the FINAL ESTIMATE states the LINEAR
  // value (85265 ≈ 85265.050) while the answer NAMES nlogn for cmp_quicksort @ n=6144.
  // The recheck must FLAG it against the named form's recompute (93606.515).
  test("(a) wrong-form value (85265, linear) under an nlogn-named answer → FLAG", () => {
    const ans = "The cmp_quicksort nlogn model at n = 6144 is the best fit.\n\nFINAL ESTIMATE: 85265 comparisons";
    const res = recheckAnswer(execTrace, ans);
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("final-estimate");
    expect(flagged[0].recomputed).toContain("nlogn(6144)");
    expect(flagged[0].recomputed).toContain("93606");
  });

  test("(a-twin) the correct nlogn value (93606) under the same answer → no flag", () => {
    const ans = "The cmp_quicksort nlogn model at n = 6144 is the best fit.\n\nFINAL ESTIMATE: 93606 comparisons";
    const res = recheckAnswer(execTrace, ans);
    expect(res.flags).toBe(0);
    const fe = res.claims.filter((c) => c.kind === "final-estimate");
    expect(fe.length).toBe(1);
    expect(fe[0].verdict).toBe("pass");
  });

  test("(b) TWO trend columns mentioned → final-estimate extracts NOTHING", () => {
    const ans =
      "The cmp_quicksort nlogn and cmp_mergesort nlogn models at n = 6144 agree.\n\nFINAL ESTIMATE: 93606 comparisons";
    const res = recheckAnswer(execTrace, ans);
    expect(res.claims.filter((c) => c.kind === "final-estimate").length).toBe(0);
  });

  test("(c) index out of envelope (n = 20000) → final-estimate extracts NOTHING", () => {
    const ans = "The cmp_quicksort nlogn model at n = 20000.\n\nFINAL ESTIMATE: 333000 comparisons";
    const res = recheckAnswer(execTrace, ans);
    expect(res.claims.filter((c) => c.kind === "final-estimate").length).toBe(0);
  });

  test("(d) unit mismatch ('FINAL ESTIMATE: 93606 volts') → extracts NOTHING", () => {
    const ans = "The cmp_quicksort nlogn model at n = 6144.\n\nFINAL ESTIMATE: 93606 volts";
    const res = recheckAnswer(execTrace, ans);
    expect(res.claims.filter((c) => c.kind === "final-estimate").length).toBe(0);
  });
});

describe("exec-trace normalize guards — group separators that must NOT be munged", () => {
  // (e) "values 1, 234" (comma+space) must NOT join into 1234; the real prediction still binds.
  test("(e) 'values 1, 234' comma+space pair is not joined", () => {
    const ans =
      "The cmp_quicksort nlogn model at n = 6144, after reviewing values 1, 234 here.\n\nFINAL ESTIMATE: 93606 comparisons";
    const res = recheckAnswer(execTrace, ans);
    const fe = res.claims.filter((c) => c.kind === "final-estimate");
    expect(fe.length).toBe(1);
    expect(fe[0].verdict).toBe("pass");
    expect(fe[0].recomputed).toContain("nlogn(6144)");
    // 1234 must never appear (would mean "1, 234" was munged into a bound number).
    for (const c of res.claims) expect(c.recomputed).not.toContain("1234");
  });

  // (f) "58 8321" is a 4-digit trailing group → the {3}\b boundary leaves it untouched.
  test("(f) '58 8321' (4-digit group) is not joined into 588321", () => {
    const ans =
      "Note the raw figure 58 8321 appears.\n\nThe cmp_quicksort nlogn model at n = 6144.\n\nFINAL ESTIMATE: 93606 comparisons";
    const res = recheckAnswer(execTrace, ans);
    const fe = res.claims.filter((c) => c.kind === "final-estimate");
    expect(fe.length).toBe(1);
    expect(fe[0].verdict).toBe("pass");
    expect(fe[0].recomputed).toContain("nlogn(6144)");
    for (const c of res.claims) expect(c.recomputed).not.toContain("588321");
  });
});

describe("exec-trace CHANGE A — LaTeX thin-space thousands ('\\!') join into one number", () => {
  // "4,\!248,\!158" must become "4248158" so the model-prediction binds. Without the join
  // it shatters to "4, 248, 158" and the prediction value never parses.
  test("'4,\\!248,\\!158 comparisons' binds quadratic(4096) for cmp_insertion", () => {
    const ans = "For cmp_insertion the quadratic model at n = 4096 yields about 4,\\!248,\\!158 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    const mp = res.claims.filter((c) => c.kind === "model-prediction");
    expect(mp.length).toBe(1);
    expect(mp[0].verdict).toBe("pass");
    expect(mp[0].recomputed).toContain("quadratic(4096)");
    expect(mp[0].recomputed).toContain("4248158");
  });

  test("thin-space-grouped twin parses identically to its plain-number form", () => {
    const grouped = "For cmp_insertion the quadratic model at n = 4096 yields about 4,\\!248,\\!158 comparisons.";
    const plain = "For cmp_insertion the quadratic model at n = 4096 yields about 4248158 comparisons.";
    const a = recheckAnswer(execTrace, grouped);
    const b = recheckAnswer(execTrace, plain);
    expect(a.checked).toBe(b.checked);
    expect(a.flags).toBe(b.flags);
    expect(a.claims.map((c) => c.recomputed)).toEqual(b.claims.map((c) => c.recomputed));
  });

  test("MUTATION: a thin-space-grouped value off by >tolerance (4,\\!500,\\!000) flags", () => {
    const ans = "For cmp_insertion the quadratic model at n = 4096 yields about 4,\\!500,\\!000 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
    expect(flagged[0].recomputed).toContain("quadratic(4096)");
  });
});

describe("exec-trace final-estimate — shape-pack suppression (no FP on thermal/battery derivations)", () => {
  // A shape-table pack's FINAL ESTIMATE is a downstream span/interpolation result, NOT the
  // bound column's point prediction — the check must extract nothing there even when a
  // column + index + matching unit are all present (the thermal multi-step derivations).
  test("thermal (shape pack) emits NO final-estimate claim for its grounded T answers", () => {
    for (const name of ["thermal-grounded-T5", "thermal-pack-T3", "thermal-t4-latex-units"]) {
      const res = recheckAnswer(thermal, loadAnswer(name));
      expect(res.claims.filter((c) => c.kind === "final-estimate").length).toBe(0);
      expect(res.flags).toBe(0);
    }
  });

  test("battery (non-shape pack) DOES bind its FINAL ESTIMATE point predictions, passing", () => {
    // Contrast: battery is a flat trend-table pack, so the FINAL ESTIMATE is the direct
    // point prediction and binds. Proves the suppression is the shape table, not a parse miss.
    const res = recheckAnswer(battery, loadAnswer("battery-T1"));
    const fe = res.claims.filter((c) => c.kind === "final-estimate");
    expect(fe.length).toBe(1);
    expect(fe[0].verdict).toBe("pass");
    expect(fe[0].recomputed).toContain("for t_cutoff_s");
  });
});

// ── FIX 1 — multi-form / multi-value pairing (verified false positive) ───────────
// Byte-exact live pack-only answer A (copied to
// fixtures as exec-trace-A-packonly). Its closing sentence names TWO distinct forms with
// TWO unit-values: "The linear model's prediction at n = 6144 (≈85 265 comparisons) is
// lower than the best-validated nlogn model's prediction (≈93 606 comparisons)." Both
// attributions are CORRECT (linear(6144)=85265.050, nlogn(6144)=93606.515). The old checker
// bound the carried single (col, form) for the paragraph and false-flagged the 85265 value
// against the nlogn recompute. The fix pairs each unit-value with its NEAREST PRECEDING form
// mention in the sentence, checking each against its own form's recompute.
describe("exec-trace A (live packonly) — multi-form closing sentence: each value to its own form", () => {
  const answer = loadAnswer("exec-trace-A-packonly");
  const res = recheckAnswer(execTrace, answer);
  const NB = String.fromCharCode(0x202f); // U+202F narrow no-break space between value digits

  test("zero flags: the closing sentence's two pairs both PASS", () => {
    expect(res.flags).toBe(0);
    expect(res.checked).toBeGreaterThanOrEqual(1);
  });

  test("the linear value (85265) binds the LINEAR recompute; the nlogn value (93606) binds NLOGN; both pass", () => {
    const closing = res.claims.filter((c) => /lower than/.test(c.claim));
    expect(closing.length).toBe(2);
    for (const c of closing) {
      expect(c.kind).toBe("model-prediction");
      expect(c.verdict).toBe("pass");
    }
    const lin = closing.find((c) => c.recomputed.includes("linear(6144)"));
    const nl = closing.find((c) => c.recomputed.includes("nlogn(6144)"));
    expect(lin).toBeDefined();
    expect(lin?.recomputed).toContain("85265");
    expect(lin?.recomputed).toContain("cmp_quicksort");
    expect(nl).toBeDefined();
    expect(nl?.recomputed).toContain("93606");
  });

  test("MUTATION (the pairing trap): the two values SWAPPED → BOTH pairs flag", () => {
    // "linear ... (93606 comparisons) ... nlogn ... (85265 comparisons)" — now each value is
    // ~8.9% off its NEAREST-PRECEDING form's recompute (linear↔93606, nlogn↔85265), inside the
    // mis-extraction window but beyond REL_PREDICTION. The nearest-preceding pairing must still
    // catch it; a single whole-sentence form binding could not. Only the closing-sentence
    // values are swapped (the derivation paragraphs above are untouched).
    const v1 = `85${NB}265`;
    const v2 = `93${NB}606`;
    const swapped = answer
      .replace(`${v1} comparisons) is lower`, `__TMP__ comparisons) is lower`)
      .replace(`${v2} comparisons).`, `${v1} comparisons).`)
      .replace("__TMP__", v2);
    // sanity: the swap actually happened (guards against a curly-quote/space byte mismatch)
    expect(swapped).not.toBe(answer);
    const mutated = recheckAnswer(execTrace, swapped);
    const closing = mutated.claims.filter((c) => /lower than/.test(c.claim));
    expect(closing.length).toBe(2);
    const flagged = closing.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(2);
    for (const c of flagged) expect(c.kind).toBe("model-prediction");
  });

  test("a value with no preceding form mention extracts nothing (high precision)", () => {
    // Two distinct forms named, but the FIRST value (85265) precedes BOTH form names → it has
    // no form to attribute it to and must be dropped; only the post-form value (93606 → nlogn)
    // pairs. cmp_quicksort token binds the column.
    const ans =
      "For cmp_quicksort at n = 6144: 85265 comparisons sits below the linear and nlogn fits, where the nlogn model gives 93606 comparisons.";
    const r = recheckAnswer(execTrace, ans);
    const mp = r.claims.filter((c) => c.kind === "model-prediction");
    expect(mp.length).toBe(1);
    expect(mp[0].recomputed).toContain("nlogn(6144)");
    expect(mp[0].verdict).toBe("pass");
  });
});

// ── FIX 2 — LaTeX "\," thin-space thousands separators join into one number ───────
describe("exec-trace normalize — LaTeX '\\,' thousands separators join (FIX 2)", () => {
  test("'4\\,248\\,158' parses as one number and binds quadratic(4096)", () => {
    const ans = "For cmp_insertion the quadratic model at n = 4096 yields about 4\\,248\\,158 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    const mp = res.claims.filter((c) => c.kind === "model-prediction");
    expect(mp.length).toBe(1);
    expect(mp[0].verdict).toBe("pass");
    expect(mp[0].recomputed).toContain("quadratic(4096)");
    expect(mp[0].recomputed).toContain("4248158");
  });

  test("'\\,'-grouped twin parses identically to its plain-number form", () => {
    const grouped = "For cmp_insertion the quadratic model at n = 4096 yields about 4\\,248\\,158 comparisons.";
    const plain = "For cmp_insertion the quadratic model at n = 4096 yields about 4248158 comparisons.";
    const a = recheckAnswer(execTrace, grouped);
    const b = recheckAnswer(execTrace, plain);
    expect(a.checked).toBe(b.checked);
    expect(a.flags).toBe(b.flags);
    expect(a.claims.map((c) => c.recomputed)).toEqual(b.claims.map((c) => c.recomputed));
  });

  test("the '\\,' join runs BEFORE the generic backslash-strip (would otherwise shatter to '94 973')", () => {
    // If the join ran after the \\[,;! ] → " " rule it would read "94 973" and stay split.
    const grouped = "Using the cmp_mergesort nlogn model at n = 8192, expect about 94\\,973 comparisons.";
    const plain = "Using the cmp_mergesort nlogn model at n = 8192, expect about 94973 comparisons.";
    const a = recheckAnswer(execTrace, grouped);
    const b = recheckAnswer(execTrace, plain);
    expect(a.claims.map((c) => c.recomputed)).toEqual(b.claims.map((c) => c.recomputed));
    const mp = a.claims.filter((c) => c.kind === "model-prediction");
    expect(mp.length).toBe(1);
    expect(mp[0].verdict).toBe("pass");
    expect(mp[0].recomputed).toContain("nlogn(8192)");
  });

  test("MUTATION: a '\\,'-grouped value off by >tolerance (4\\,500\\,000) flags", () => {
    const ans = "For cmp_insertion the quadratic model at n = 4096 yields about 4\\,500\\,000 comparisons.";
    const res = recheckAnswer(execTrace, ans);
    const flagged = res.claims.filter((c) => c.verdict === "flag");
    expect(flagged.length).toBe(1);
    expect(flagged[0].kind).toBe("model-prediction");
    expect(flagged[0].recomputed).toContain("quadratic(4096)");
  });
});

// ── FIX 3 — division sign "÷" maps to "/" so a ÷ ratio grounds via the quotient path ─
describe("exec-trace normalize — '÷' maps to '/' (FIX 3)", () => {
  test("an explicit '31775 ÷ 43011' division grounds identically to its '/' twin", () => {
    // n = 3072 dataset record: cmp_mergesort=31775, cmp_quicksort=43011 → 73.88%. With the
    // values carrying the "comparisons" unit and the index on the same line, the single-sentence
    // ratio path binds. The ÷-form must parse the same as the /-form.
    const divver =
      "At n = 3072, cmp_mergesort = 31775 comparisons and cmp_quicksort = 43011 comparisons; 31775 ÷ 43011 ≈ 73.9%.";
    const slasher =
      "At n = 3072, cmp_mergesort = 31775 comparisons and cmp_quicksort = 43011 comparisons; 31775 / 43011 ≈ 73.9%.";
    const a = recheckAnswer(execTrace, divver);
    const b = recheckAnswer(execTrace, slasher);
    expect(a.claims.map((c) => c.recomputed)).toEqual(b.claims.map((c) => c.recomputed));
    expect(a.flags).toBe(b.flags);
    expect(a.checked).toBe(b.checked);
  });
});

// ── FIX 4 — trap-C fixtures: byte-exact in-table ratios (correct, at n=3072) ──────────
// Both C answers state a TRUE in-table ratio cmp_mergesort/cmp_quicksort = 31775/43011 =
// 73.88% at n = 3072. After FIX 2 (\, join) and FIX 3 (÷→/) the literals normalize cleanly,
// but BOTH fixtures still yield checked=0 for STRUCTURAL reasons documented below. Per the
// high-precision doctrine these are DECLINED rather than rescued with a risky new binding path
// — a false positive is worse than a missed pass. The declines are asserted so any future
// change is a conscious test edit, and the negative twins are checked=0 too (nothing binds, so
// nothing can flag).
describe("exec-trace C (live lenspack) — \\frac ratio: justified structural decline", () => {
  // ans-C__lenspack.md writes the ratio as a LaTeX fraction "\frac{31\,775}{43\,011}". FIX 2
  // joins the thin-space groups (→ \frac{31775}{43011}), but \frac{X}{Y} is NOT an "X / Y" /
  // "X ÷ Y" quotient — the backslash-strip leaves "frac{31775}{43011}", which the ratio-window
  // ratioRe (digits [/÷] digits) does not match. Recognizing \frac{}{} as a quotient is a NEW
  // binding path (FP-dangerous: \frac is also used for non-ratio algebra, e.g. the battery T4
  // "\frac{1.89684 - 1.40}{0.00370267}" intermediate), so it is deliberately NOT added. The
  // operands also carry no per-line index (n=3072 is on a separate intro line), a second gap.
  const answer = loadAnswer("exec-trace-C-lenspack");
  const res = recheckAnswer(execTrace, answer);

  test("DECLINED: checked 0, flags 0 (\\frac{}{} is not recognized as a quotient)", () => {
    expect(res.checked).toBe(0);
    expect(res.flags).toBe(0);
    expect(res.claims).toEqual([]);
  });

  test("negative twin: doctoring the percentage to 81.2% still binds NOTHING (no flag, the fixture declines)", () => {
    // The fixture does not bind, so even a clearly-wrong ratio cannot flag. This pins the
    // decline: were a \frac-quotient path ever added, this test would have to change AND a
    // passing 73.9% / flagging 81.2% pair would be expected (73.88 vs 81.2 is outside ±3pp).
    const doctored = answer.replace("73.9", "81.2");
    expect(doctored).not.toBe(answer);
    const r = recheckAnswer(execTrace, doctored);
    expect(r.checked).toBe(0);
    expect(r.flags).toBe(0);
  });
});

describe("exec-trace C (live packonly) — unitless bullet operands: justified structural decline", () => {
  // ans-C__packonly.md: FIX 3 turns "31775 ÷ 43011" into a clean "31775 / 43011" quotient that
  // ratioRe DOES match. But the operands sit on bullet lines as bare "cmp_mergesort = 31775"
  // with NO unit token ("comparisons" omitted) and NO per-line index (n=3072 is in the header
  // paragraph). The ratio-window grounds operands only via "single index per line + value-with-
  // unit"; with no unit and the index a paragraph away, zero grounding statements are collected.
  // Grounding bare column-token=value against the dataset with a cross-paragraph index carry is
  // a NEW, FP-dangerous binding path — declined (it regresses battery C / battery T4). The ÷→/
  // normalization (FIX 3) is still real and load-bearing; it is just not sufficient here.
  const answer = loadAnswer("exec-trace-C-packonly");
  const res = recheckAnswer(execTrace, answer);

  test("DECLINED: checked 0, flags 0 (operands unitless + index cross-paragraph)", () => {
    expect(res.checked).toBe(0);
    expect(res.flags).toBe(0);
    expect(res.claims).toEqual([]);
  });

  test("negative twin: doctoring 73.88% → 81.2% still binds NOTHING (decline holds both directions)", () => {
    const doctored = answer.replace("73.88%", "81.2%");
    expect(doctored).not.toBe(answer);
    const r = recheckAnswer(execTrace, doctored);
    expect(r.checked).toBe(0);
    expect(r.flags).toBe(0);
  });
});

// ── FIX 5 — A lens+pack: final prediction has form+value but no column token / index ──
describe("exec-trace A (live lenspack) — cross-paragraph carry: justified structural decline", () => {
  // ans-A__lenspack.md fragments the derivation across many tiny paragraphs. The closing
  // sentence ("The linear model's prediction (85 265) is lower than the best-validated model's
  // prediction (93 606).") names only ONE form ("linear" — the second is the unnamed "best-
  // validated model"), carries NEITHER the "comparisons" unit NOR an index (n=6144 is paragraphs
  // away), and has no column token of its own. Binding it would require cross-paragraph column
  // AND index carry across 11 intervening paragraphs — a known FP-dangerous path that is
  // deliberately NOT added. Asserted so any future change to cross-paragraph carry is conscious.
  const res = recheckAnswer(execTrace, loadAnswer("exec-trace-A-lenspack"));

  test("DECLINED: checked 0, flags 0 (no in-paragraph column/index/unit on the closing line)", () => {
    expect(res.checked).toBe(0);
    expect(res.flags).toBe(0);
    expect(res.claims).toEqual([]);
  });
});
