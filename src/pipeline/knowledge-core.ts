// KE tiering: select the Core subset of Knowledge Extract entries for consult injection.
// The LLM only SELECTS unit numbers — it never rewrites text. Rebuild is deterministic,
// so selecting all units reproduces the original document (lossless by construction).
// Full KE stays in knowledge_extract; Core goes to knowledge_core (null = fall back to full).

import { AGENT_K_CORE_PROMPT } from "../prompts.ts";

export interface Segment {
  kind: "skeleton" | "unit";
  level: number; // heading level for skeleton (1-2); 0 for prose skeleton; 3+ or 0 for units
  text: string;
}

const UNIT_HEADING = /^#{3,4}\s/;
const SKELETON_HEADING = /^#{1,2}\s/;
const TOP_BULLET = /^- /;
const INDENTED = /^\s+\S/;

export function parseKnowledgeUnits(ke: string): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  const close = () => { if (current) { segments.push(current); current = null; } };

  for (const line of ke.split("\n")) {
    if (SKELETON_HEADING.test(line)) {
      close();
      segments.push({ kind: "skeleton", level: line.startsWith("##") ? 2 : 1, text: line });
    } else if (UNIT_HEADING.test(line)) {
      close();
      current = { kind: "unit", level: 3, text: line };
    } else if (current && current.level >= 3) {
      // inside a heading unit: everything until the next heading belongs to it
      current.text += `\n${line}`;
    } else if (TOP_BULLET.test(line)) {
      close();
      current = { kind: "unit", level: 0, text: line };
    } else if (current && (INDENTED.test(line) || line.trim() === "")) {
      // bullet unit continues through indented lines and blank lines
      current.text += `\n${line}`;
    } else {
      // col-0 prose outside any unit: skeleton (section intros etc.)
      close();
      const prev = segments[segments.length - 1];
      if (prev && prev.kind === "skeleton" && prev.level === 0) prev.text += `\n${line}`;
      else segments.push({ kind: "skeleton", level: 0, text: line });
    }
  }
  close();
  return segments;
}

export function rebuildFromSelection(segments: Segment[], selected: Set<number>): string {
  // Everything is kept by default. A heading section (level 1/2) is dropped — with all
  // its non-unit content — only when it contains zero selected units in its span.
  // Unselected units are always dropped. Selecting all units reproduces the document.
  const unitNumber = new Array<number>(segments.length).fill(0);
  let n = 0;
  for (let i = 0; i < segments.length; i++) if (segments[i].kind === "unit") unitNumber[i] = ++n;

  // Drop a section only if it HAS units and none are selected. Prose-only
  // sections (intros, integration notes) have nothing selectable — keep them.
  const sectionDropped = (start: number, level: number): boolean => {
    let hasUnits = false;
    for (let i = start + 1; i < segments.length; i++) {
      const s = segments[i];
      if (s.kind === "skeleton" && s.level >= 1 && s.level <= level) break;
      if (s.kind === "unit") {
        hasUnits = true;
        if (selected.has(unitNumber[i])) return false;
      }
    }
    return hasUnits;
  };

  const keep = new Array<boolean>(segments.length).fill(true);
  let droppedUntilLevel = 0; // >0: inside a dropped section of this level
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.kind === "skeleton" && s.level >= 1) {
      if (droppedUntilLevel > 0 && s.level <= droppedUntilLevel) droppedUntilLevel = 0;
      if (droppedUntilLevel === 0 && sectionDropped(i, s.level)) droppedUntilLevel = s.level;
      keep[i] = droppedUntilLevel === 0;
    } else if (s.kind === "unit") {
      keep[i] = droppedUntilLevel === 0 && selected.has(unitNumber[i]);
    } else {
      keep[i] = droppedUntilLevel === 0;
    }
  }
  return segments
    .filter((_, i) => keep[i])
    .map((s) => s.text.replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean)
    .join("\n\n");
}

function numberUnits(segments: Segment[]): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  let n = 0;
  for (const s of segments) if (s.kind === "unit") out.push({ n: ++n, text: s.text.trim() });
  return out;
}

function parseSelection(raw: string, max: number): number[] | null {
  const cleaned = raw.replace(/```(json)?/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { core?: unknown };
    if (!Array.isArray(obj.core)) return null;
    const nums = obj.core.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= max);
    return nums.length > 0 ? nums : null;
  } catch {
    return null;
  }
}

const BATCH_CHAR_BUDGET = 60_000;

export async function buildCoreKnowledge(
  logicDocument: string,
  knowledgeExtract: string,
  callLLM: (system: string, user: string, options: { temperature?: number }) => Promise<string>,
  opts: { maxRatio?: number } = {}
): Promise<string | null> {
  // The selector returns entries ordered most-core first; we truncate to budget here,
  // deterministically — LLMs over-include, code enforces the cap.
  const maxRatio = opts.maxRatio ?? 0.5;
  const segments = parseKnowledgeUnits(knowledgeExtract);
  const units = numberUnits(segments);
  if (units.length < 8) return null; // tiny KE: tiering buys nothing, consult full

  const batches: { n: number; text: string }[][] = [];
  let batch: { n: number; text: string }[] = [];
  let size = 0;
  for (const u of units) {
    if (size + u.text.length > BATCH_CHAR_BUDGET && batch.length > 0) { batches.push(batch); batch = []; size = 0; }
    batch.push(u);
    size += u.text.length;
  }
  if (batch.length > 0) batches.push(batch);

  const selected = new Set<number>();
  for (const b of batches) {
    const listing = b.map((u) => `[${u.n}]\n${u.text}`).join("\n\n");
    const prompt = AGENT_K_CORE_PROMPT(logicDocument, listing, b.length, units.length);
    let nums: number[] | null = null;
    for (let attempt = 0; attempt < 2 && !nums; attempt++) {
      try {
        nums = parseSelection(await callLLM(prompt.system, prompt.user, { temperature: 0.1 }), units.length);
      } catch {
        nums = null;
      }
    }
    if (!nums) return null; // degrade safely: no core → consult uses full KE
    for (const n of nums.slice(0, Math.ceil(b.length * maxRatio))) selected.add(n);
  }

  if (selected.size === 0 || selected.size === units.length) return null;
  return rebuildFromSelection(segments, selected);
}
