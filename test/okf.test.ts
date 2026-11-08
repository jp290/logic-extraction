import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildOkfBundle,
  validateOkfBundle,
  bundleToTarGz,
  createdAtEpoch,
  type OkfRow,
} from "../src/okf.ts";

// A real gated lens with all layers + grounding report: the cooking interview
// published in examples/cooking-interview/.
const FULL_LENS = "1e30d27ac6df";
const BASE = "https://lens.example";

function fetchRow(id: string): OkfRow {
  const row = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "okf", "cooking-interview.row.json"), "utf-8")) as OkfRow;
  if (row.id !== id) throw new Error(`fixture lens ${id} not found`);
  return row;
}

describe("buildOkfBundle — round-trip a real gated lens", () => {
  const row = fetchRow(FULL_LENS);
  const bundle = buildOkfBundle(row, BASE);
  const byPath = new Map(bundle.files.map((f) => [f.path, f.content]));

  test("emits index + one file per present layer + log", () => {
    expect(byPath.has("index.md")).toBe(true);
    expect(byPath.has("logic-document.md")).toBe(true);
    expect(byPath.has("knowledge-extract.md")).toBe(true);
    expect(byPath.has("understanding.md")).toBe(true);
    expect(byPath.has("log.md")).toBe(true);
    expect(bundle.files.length).toBe(5);
  });

  test("passes OKF validation: type on every concept, links resolve", () => {
    expect(validateOkfBundle(bundle.files)).toEqual([]);
  });

  test("every markdown file carries a `type` frontmatter field", () => {
    const types: Record<string, string> = {
      "index.md": "Lens",
      "logic-document.md": "Reasoning Dynamics",
      "knowledge-extract.md": "Knowledge Extract",
      "understanding.md": "Understanding",
      "log.md": "Change Log",
    };
    for (const [path, expectedType] of Object.entries(types)) {
      const fm = byPath.get(path)!.match(/^---\n([\s\S]*?)\n---/)![1];
      expect(fm).toContain(`type: "${expectedType}"`);
    }
  });

  test("index.md carries recommended OKF fields and canonical resource", () => {
    const idx = byPath.get("index.md")!;
    const fm = idx.match(/^---\n([\s\S]*?)\n---/)![1];
    expect(fm).toContain(`title: "${row.title}"`);
    expect(fm).toContain(`resource: "${BASE}/e/${FULL_LENS}"`);
    expect(fm).toMatch(/^tags: \[/m);
    expect(fm).toMatch(/^timestamp: /m);
    // Cross-links to each layer (spec: relative markdown links)
    expect(idx).toContain("[Logic Document](./logic-document.md)");
    expect(idx).toContain("[Knowledge Extract](./knowledge-extract.md)");
    expect(idx).toContain("[Understanding](./understanding.md)");
    expect(idx).toContain("[Change log](./log.md)");
  });

  test("emitted layer content is byte-identical to the stored gated docs (no regeneration)", () => {
    // The stored doc must appear verbatim in the emitted file body.
    expect(byPath.get("logic-document.md")).toContain(row.logic_document!.trim());
    expect(byPath.get("knowledge-extract.md")).toContain(row.knowledge_extract!.trim());
    expect(byPath.get("understanding.md")).toContain(row.understanding_document!.trim());
  });

  test("log.md records model string and grounding summary", () => {
    const log = byPath.get("log.md")!;
    expect(log).toContain(row.model!);
    expect(log).toContain("Entity grounding score:");
  });
});

describe("buildOkfBundle — partial lens (missing layers)", () => {
  test("omits absent layers and never links to a missing file", () => {
    const partial: OkfRow = {
      id: "deadbeef0001",
      title: "Edge: LD only",
      author: null,
      doc_type: null,
      topic_summary: null,
      domain_tags: null,
      created_at: "2026-06-13 00:00:00",
      model: "test-model",
      logic_document: "# Logic\nReasoning content.",
      knowledge_extract: null,
      understanding_document: null,
      grounding_report: null,
    };
    const bundle = buildOkfBundle(partial, BASE);
    const names = bundle.files.map((f) => f.path).sort();
    expect(names).toEqual(["index.md", "log.md", "logic-document.md"]);
    expect(validateOkfBundle(bundle.files)).toEqual([]);
    // No dangling links to layers that were not emitted.
    const idx = bundle.files.find((f) => f.path === "index.md")!.content;
    expect(idx).not.toContain("knowledge-extract.md");
    expect(idx).not.toContain("understanding.md");
  });

  test("empty-string layers are treated as absent", () => {
    const bundle = buildOkfBundle({
      id: "deadbeef0002",
      title: "Edge: empty strings",
      author: null,
      doc_type: null,
      topic_summary: null,
      domain_tags: null,
      created_at: "2026-06-13 00:00:00",
      model: null,
      logic_document: "real",
      knowledge_extract: "   ",
      understanding_document: "",
      grounding_report: null,
    }, BASE);
    expect(bundle.files.some((f) => f.path === "knowledge-extract.md")).toBe(false);
    expect(bundle.files.some((f) => f.path === "understanding.md")).toBe(false);
  });
});

describe("validateOkfBundle — catches malformed bundles (should-fail cases)", () => {
  test("flags a concept file missing `type`", () => {
    const issues = validateOkfBundle([
      { path: "index.md", content: '---\ntitle: "x"\n---\n\nbody' },
    ]);
    expect(issues).toContainEqual({ file: "index.md", issue: "missing required `type` field" });
  });

  test("flags missing frontmatter entirely", () => {
    const issues = validateOkfBundle([{ path: "index.md", content: "no frontmatter here" }]);
    expect(issues).toContainEqual({ file: "index.md", issue: "malformed or missing YAML frontmatter" });
  });

  test("flags a dangling relative link", () => {
    const issues = validateOkfBundle([
      { path: "index.md", content: '---\ntype: "Lens"\n---\n\n[gone](./nope.md)' },
    ]);
    expect(issues).toContainEqual({ file: "index.md", issue: "dangling link to ./nope.md" });
  });

  test("flags a bundle with no index.md", () => {
    const issues = validateOkfBundle([
      { path: "log.md", content: '---\ntype: "Change Log"\n---\n\nbody' },
    ]);
    expect(issues).toContainEqual({ file: "(bundle)", issue: "missing required index.md" });
  });
});

describe("YAML frontmatter — well-formed under adversarial titles", () => {
  test("escapes quotes and colons in titles", () => {
    const bundle = buildOkfBundle({
      id: "deadbeef0003",
      title: 'A "Quoted": title, with colon',
      author: null,
      doc_type: null,
      topic_summary: 'desc with "quotes"',
      domain_tags: '["a","b"]',
      created_at: "2026-06-13 00:00:00",
      model: null,
      logic_document: "x",
      knowledge_extract: null,
      understanding_document: null,
      grounding_report: null,
    }, BASE);
    const idx = bundle.files.find((f) => f.path === "index.md")!.content;
    const fm = idx.match(/^---\n([\s\S]*?)\n---/)![1];
    expect(fm).toContain('title: "A \\"Quoted\\": title, with colon"');
    expect(fm).toContain('tags: ["a", "b"]');
    // Still parses as a valid bundle.
    expect(validateOkfBundle(bundle.files)).toEqual([]);
  });
});

describe("bundleToTarGz — produces a gzip stream", () => {
  test("gzip magic header and deterministic for same input", () => {
    const row = fetchRow(FULL_LENS);
    const bundle = buildOkfBundle(row, BASE);
    const epoch = createdAtEpoch(row.created_at);
    const a = bundleToTarGz(bundle, bundle.slug, epoch);
    const b = bundleToTarGz(bundle, bundle.slug, epoch);
    expect(a[0]).toBe(0x1f);
    expect(a[1]).toBe(0x8b); // gzip magic
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test("createdAtEpoch parses SQLite datetime to a finite epoch", () => {
    const e = createdAtEpoch("2026-06-13 08:47:00");
    expect(e).toBeGreaterThan(1_700_000_000);
    expect(Number.isFinite(e)).toBe(true);
  });
});
