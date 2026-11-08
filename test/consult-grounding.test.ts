import { describe, expect, test } from "bun:test";
import { consultGrounding } from "../src/gates/consult-grounding.ts";

const SOURCE = `Acme Cloud Services Agreement
Your subscription renews automatically at the end of each Initial Term unless you
cancel via the Manage Subscription page or email support@acme.example.
Reports of abuse go to https://www.asacp.org/ or law enforcement.
Disputes follow Federal Rule of Civil Procedure 11(b) and 18 U.S.C. §2258A.
The Communications Decency Act provides immunity under 47 U.S.C. §230(d).
Liability is capped at $100.00 or six months of fees, whichever is less.
The accuracy was measured at 94.7% across 12,450 trials.`;

function spans(answer: string, rule?: string): string[] {
  return consultGrounding(answer, SOURCE)
    .flags.filter((f) => !rule || f.rule === rule)
    .map((f) => f.span);
}

describe("R1 proper names", () => {
  test("flags a multi-word org name absent from source", () => {
    expect(spans("Report abuse to the Internet Watch Foundation instead.", "proper-name"))
      .toEqual(["Internet Watch Foundation"]);
  });
  test("flags an absent name at sentence start", () => {
    expect(spans("Digital Trust Alliance handles renewal disputes.", "proper-name"))
      .toEqual(["Digital Trust Alliance"]);
  });
  test("grounds a present name case-insensitively across source line wraps", () => {
    expect(spans("Cancel on the Manage Subscription page.", "proper-name")).toEqual([]);
  });
  test("does not treat sentence-start function words as name parts", () => {
    expect(spans("The Initial Term renews unless you cancel.", "proper-name")).toEqual([]);
  });
  test("splits at possessives: grounded head does not flag", () => {
    expect(spans("Send notice to Acme's Initial Term desk.", "proper-name")).toEqual([]);
  });
  test("splits at possessives: fabricated head still flags", () => {
    expect(spans("As stated in Acme's Data Protection Addendum.", "proper-name"))
      .toEqual(["Data Protection Addendum"]);
  });
});

describe("R2 acronyms", () => {
  test("flags an acronym absent as literal and expansion", () => {
    expect(spans("Confidentiality breaches fall under the DPA.", "acronym")).toEqual(["DPA"]);
  });
  test("grounds via Title-Case initials expansion", () => {
    expect(spans("The CDA shields the provider.", "acronym")).toEqual([]);
  });
  test("grounds via URL label match", () => {
    expect(spans("Report to ASACP for non-hosted content.", "acronym")).toEqual([]);
  });
  test("ignores emphasis capitalization and roman numerals", () => {
    expect(spans("Do NOT send the image. See Part III.", "acronym")).toEqual([]);
  });
});

describe("R3 citations", () => {
  test("flags a citation whose numeric core is absent", () => {
    expect(spans("Mandated by 18 U.S.C. §1030.", "citation")).toEqual(["18 U.S.C. §1030"]);
  });
  test("grounds a shortened rule citation by its numeric core", () => {
    expect(spans("Counsel certifies under Rule 11(b).", "citation")).toEqual([]);
  });
});

describe("R4 urls/emails", () => {
  test("flags an absent email, grounds a present one", () => {
    expect(spans("Write to abuse@acme.example or support@acme.example.", "url-email"))
      .toEqual(["abuse@acme.example"]);
  });
  test("flags an absent URL", () => {
    expect(spans("See www.iwf.org.uk for details.", "url-email")).toEqual(["www.iwf.org.uk"]);
  });
});

describe("numeric path", () => {
  test("flags an untraceable measured value", () => {
    expect(spans("Accuracy was 87.3% across trials.", "numeric")).toEqual(["87.3%"]);
  });
  test("grounds values present in source", () => {
    expect(spans("Accuracy was 94.7% across 12,450 trials.", "numeric")).toEqual([]);
  });
});

describe("silencing classes", () => {
  test("S1: heading and bold list labels are not source-attributed", () => {
    const answer = "## The Catastrophic Failure Mode\n\n**Mandatory Individual Arbitration**\n\n1. **Detailed Demand Checklist** – cancel via the Manage Subscription page.";
    expect(spans(answer)).toEqual([]);
  });
  test("S2: section cross-references are exempt", () => {
    expect(spans("As Section 4.2.2 and Sections 3, 7.1 explain, fees apply.")).toEqual([]);
  });
  test("S3: a quoted phrase is not itself an entity, entities inside are checked", () => {
    expect(spans('The "passive conduit" status holds.')).toEqual([]);
    expect(spans('They cite the "Internet Watch Foundation report" here.', "proper-name"))
      .toEqual(["Internet Watch Foundation"]);
  });
});

describe("boundaries", () => {
  test("empty answer produces no flags and zero counts", () => {
    const r = consultGrounding("", SOURCE);
    expect(r.flags).toEqual([]);
    expect(r.checked.properNames).toBe(0);
  });
  test("empty source flags answer entities rather than erroring", () => {
    const r = consultGrounding("Contact the Internet Watch Foundation about the DPA.", "");
    expect(r.flags.some((f) => f.span.includes("Internet Watch Foundation"))).toBe(true);
    expect(r.flags.map((f) => f.span)).toContain("DPA");
  });
  test("flags carry answer context windows", () => {
    const r = consultGrounding("Report abuse to the Internet Watch Foundation instead.", SOURCE);
    expect(r.flags[0].context).toContain("Report abuse to the Internet Watch Foundation");
  });
});
