// consult-grounding: deterministic consult-time entity + numeric provenance check
// for lens-only consult answers against the lens's stored extraction source text
// (rule classes were fixed before the checker was calibrated).
//
// Flags annotate; they never block, rewrite, or suppress an answer. Pure TS, no
// LLM, no network. Numeric direction reuses the frozen numeric-reconcile kernel
// (provenance side only — an answer is not expected to COVER source numbers).
//
// Positive rule classes (a flag = answer element absent from source):
//   R1 proper-name — multi-word capitalized name sequence, case-insensitive
//                    whitespace-normalized phrase match
//   R2 acronym     — all-caps token (2–5 chars) absent as literal word AND as a
//                    capitalized initials-expansion
//   R3 citation    — statute/rule citation whose numeric core is absent
//   R4 url-email   — URL or email address absent as a literal
//   numeric        — numeric-reconcile untraceable candidates
// Silencing classes (disclosed in findings, symmetry rule):
//   S1 answer-structural headings / bold list labels are not source-attributed
//   S2 section/outline cross-references are outline-derivable, exempt
//   S3 a quoted phrase is not itself an entity (entities inside still checked)
//   S4 number+unit tokens belong to the numeric path, never the entity check

import { numericReconcile } from "./numeric-reconcile.ts";

export type ConsultFlagRule = "proper-name" | "acronym" | "citation" | "url-email" | "numeric";

export interface ConsultFlag {
  rule: ConsultFlagRule;
  span: string; // the answer element the flag is bound to
  context: string; // answer window around the span
  // "lens" = the span grounds in the lens's own layers (LD/KE/UD): lens-coined
  // vocabulary, not consult-time fabrication. "unknown" = grounds nowhere.
  origin: "lens" | "unknown";
}

export interface ConsultGroundingReport {
  flags: ConsultFlag[];
  checked: { properNames: number; acronyms: number; citations: number; urlsEmails: number; numericCandidates: number };
  verified: { properNames: string[]; acronyms: string[]; citations: string[]; urlsEmails: string[] };
}

const CONTEXT_CHARS = 90;

// S1 — answer-structural text: markdown headings, bold-only heading lines, and
// bold list-item labels ("1. **45-day Informal Dispute Resolution** – ...") are
// the answer's own organization, not claims attributed to the source.
function stripAnswerStructure(answer: string): string {
  return answer
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^\*\*[^*\n]+\*\*:?\s*$/gm, "")
    .replace(/^(\s*(?:[-*•]|\d+\.)\s+)\*\*[^*\n]+\*\*\s*[–—:-]\s*/gm, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\[Source:[^\]]*\]/g, "")
    .replace(/\[Context:[^\]]*\]/g, "");
}

// S2 — outline-derivable structural cross-references ("Section 4.2.2",
// "Sections 3, 4.2.1"). Mirror of the numeric kernel's section-label dialect.
const SECTION_REF = /\b(?:section|§|chapter|part|appendix|clause|article)s?\s+\d+(?:\.\d+)*(?:\([a-z0-9]+\))?(?:\s*(?:,|and|&|-|–)\s*\d+(?:\.\d+)*(?:\([a-z0-9]+\))?)*/gi;

function stripSectionRefs(text: string): string {
  return text.replace(SECTION_REF, " ");
}

// shared normalization for phrase grounding: case-fold, fold smart punctuation,
// collapse all whitespace (the stored source is hard-wrapped — names span lines)
function foldText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
}

// ── R1 proper names ───────────────────────────────────────────────────────────
// Sequences of ≥2 capitalized words on one line, joined by spaces or lowercase
// connector words. Leading English function words (sentence-start capitalization)
// are trimmed before the ≥2-word requirement.
const NAME_WORD = "[A-Z][a-zA-Z'’-]+";
const NAME_CONNECT = "(?:of|the|and|in|for|on|de|von|van|al|el|la|le|&)";
const PROPER_NAME_RE = new RegExp(
  `\\b${NAME_WORD}(?:[ ]+(?:${NAME_CONNECT}[ ]+)?${NAME_WORD}){1,5}\\b`,
  "g",
);
const LEAD_STOPWORDS = new Set([
  "the", "a", "an", "if", "but", "so", "it", "its", "you", "your", "we", "our",
  "this", "that", "these", "those", "there", "when", "what", "who", "how",
  "why", "where", "while", "as", "at", "by", "to", "from", "and", "or", "not",
  "no", "any", "all", "both", "each", "every", "some", "such", "let", "is",
  "are", "was", "be", "do", "does", "don't", "in", "on", "of", "for", "with",
]);

function extractProperNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(PROPER_NAME_RE)) {
      // a possessive marks a determiner relationship ("Runpod's Notice Address"),
      // not a name constituent — split the run at possessive words and treat each
      // segment as its own candidate
      const segments: string[][] = [[]];
      for (const w of m[0].split(/\s+/)) {
        segments[segments.length - 1].push(w);
        if (/['’]s$/.test(w)) segments.push([]);
      }
      for (const seg of segments) {
        const words = [...seg];
        while (words.length > 0 && LEAD_STOPWORDS.has(words[0].toLowerCase())) words.shift();
        while (words.length > 0 && LEAD_STOPWORDS.has(words[words.length - 1].toLowerCase())) words.pop();
        // a trailing possessive is inflection, not part of the name
        if (words.length > 0) words[words.length - 1] = words[words.length - 1].replace(/['’]s$/, "");
        if (words.filter((w) => /^[A-Z]/.test(w)).length >= 2) names.add(words.join(" "));
      }
    }
  }
  return [...names];
}

// Sentence-start capitalization makes a run's leading word ambiguous ("Contact
// Account Settings") — grounding tests every suffix of the run that still has ≥2
// capitalized words. Residual blind spot (disclosed): a fabricated name whose
// tail phrase appears in the source is masked.
function properNameGrounded(name: string, foldedSource: string): boolean {
  const words = name.split(" ");
  for (let i = 0; i <= words.length - 2; i++) {
    const suffix = words.slice(i);
    if (suffix.filter((w) => /^[A-Z]/.test(w)).length < 2) break;
    if (foldedSource.includes(foldText(suffix.join(" ")))) return true;
  }
  return false;
}

// ── R2 acronyms ───────────────────────────────────────────────────────────────
const ACRONYM_RE = /\b[A-Z]{2,5}\b/g;
// emphasis-capitalization of common English words ("do NOT send") and roman
// numerals are not acronyms
const ACRONYM_NOISE = new Set([
  "NOT", "AND", "OR", "THE", "ONLY", "ALL", "ANY", "NO", "IS", "ARE", "BE",
  "DO", "IF", "BUT", "SO", "NEVER", "MUST", "CAN", "WILL", "YOU", "YOUR", "WE",
  "OUR", "THIS", "THAT", "FOR", "WITH", "VERY", "EVERY",
]);
const ROMAN_RE = /^[IVXLCDM]+$/;

function extractAcronyms(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ACRONYM_RE)) {
    const tok = m[0];
    if (ACRONYM_NOISE.has(tok) || ROMAN_RE.test(tok)) continue;
    out.add(tok);
  }
  return [...out];
}

// grounded if present as a literal word (case-sensitive — acronyms are written in
// caps), case-insensitively inside a URL/email/domain token ("ASACP" grounds on
// "www.asacp.org"), or as a capitalized initials-expansion ("CDA" →
// "Communications Decency Act"), connectors allowed between expansion words
function acronymGrounded(acr: string, source: string): boolean {
  if (new RegExp(`\\b${acr}\\b`).test(source)) return true;
  const label = new RegExp(`(?:^|[./@])${acr.toLowerCase()}(?:$|[./@])`);
  for (const m of source.matchAll(URL_EMAIL_RE)) {
    if (label.test(m[0].toLowerCase())) return true;
  }
  const expansion = [...acr]
    .map((ch) => `${ch.toUpperCase()}[a-zA-Z'’-]+`)
    .join(`\\s+(?:(?:of|the|and|for|&)\\s+)*`);
  return new RegExp(`\\b${expansion}`).test(source);
}

// ── R3 citations ──────────────────────────────────────────────────────────────
// Answers legitimately shorten citation forms ("Federal Rule of Civil Procedure
// 11(b)" → "Rule 11(b)"), so grounding tests the numeric core, not the literal.
const CITATION_RE = /\b\d+\s+U\.?\s?S\.?\s?C\.?\s*§{0,2}\s*\d+[A-Za-z]?(?:\([a-z0-9]+\))?|\bRule\s+\d+(?:\.\d+)?(?:\([a-z0-9]+\))?|§\s*\d+[A-Za-z]?(?:\([a-z0-9]+\))?/g;
const CITE_CORE_RE = /\d+[A-Za-z]?(?:\([a-z0-9]+\))?(?!.*\d)/;

function extractCitations(text: string): string[] {
  return [...new Set([...text.matchAll(CITATION_RE)].map((m) => m[0].trim()))];
}

function citationGrounded(cite: string, source: string): boolean {
  const core = cite.match(CITE_CORE_RE)?.[0];
  if (!core) return true; // no core to test — never flag on an unparseable form
  const escaped = core.replace(/[().]/g, "\\$&");
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d])`).test(source);
}

// ── R4 URLs / emails ──────────────────────────────────────────────────────────
const URL_EMAIL_RE = /(?:https?:\/\/|www\.)[^\s)\]'"<>]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

function extractUrlsEmails(text: string): string[] {
  return [...new Set([...text.matchAll(URL_EMAIL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, "")))];
}

// ── the checker ───────────────────────────────────────────────────────────────
function contextFor(answer: string, span: string): string {
  const i = answer.indexOf(span);
  if (i < 0) return span;
  return answer
    .slice(Math.max(0, i - CONTEXT_CHARS), i + span.length + CONTEXT_CHARS)
    .replace(/\s+/g, " ")
    .trim();
}

// `lensText` (LD/KE/UD concatenated) classifies flag origin: a span that grounds
// in the lens's own layers is lens-coined vocabulary carried into the answer, not
// consult-time fabrication — persisted, but distinguishable for surfacing.
export function consultGrounding(answer: string, source: string, lensText = ""): ConsultGroundingReport {
  const structural = stripAnswerStructure(answer);
  const entityText = stripSectionRefs(structural);
  const foldedSource = foldText(source);
  const foldedLens = foldText(lensText);

  const flags: ConsultFlag[] = [];
  const verified: ConsultGroundingReport["verified"] = { properNames: [], acronyms: [], citations: [], urlsEmails: [] };
  const originOf = (grounded: boolean): "lens" | "unknown" => (grounded ? "lens" : "unknown");

  const properNames = extractProperNames(entityText);
  for (const name of properNames) {
    if (properNameGrounded(name, foldedSource)) verified.properNames.push(name);
    else flags.push({ rule: "proper-name", span: name, context: contextFor(answer, name), origin: originOf(foldedLens !== "" && properNameGrounded(name, foldedLens)) });
  }

  const acronyms = extractAcronyms(entityText);
  for (const acr of acronyms) {
    if (acronymGrounded(acr, source)) verified.acronyms.push(acr);
    else flags.push({ rule: "acronym", span: acr, context: contextFor(answer, acr), origin: originOf(lensText !== "" && acronymGrounded(acr, lensText)) });
  }

  // citations are extracted before S2 stripping would eat "§ 230(d)" forms, but
  // from the structure-stripped text so heading citations don't double-count
  const citations = extractCitations(structural);
  for (const cite of citations) {
    if (citationGrounded(cite, source)) verified.citations.push(cite);
    else flags.push({ rule: "citation", span: cite, context: contextFor(answer, cite), origin: originOf(lensText !== "" && citationGrounded(cite, lensText)) });
  }

  const urls = extractUrlsEmails(structural);
  for (const u of urls) {
    if (foldedSource.includes(foldText(u))) verified.urlsEmails.push(u);
    else flags.push({ rule: "url-email", span: u, context: contextFor(answer, u), origin: originOf(foldedLens !== "" && foldedLens.includes(foldText(u))) });
  }

  // S2 applies to the numeric direction too: outline-derivable section references
  // ("Sections 3, 7.1") are exempt from consult-time numeric flagging (Task-1
  // pre-authorized class). The frozen kernel itself is untouched — the stripping
  // is consult-side preprocessing only.
  const numeric = numericReconcile(source, stripSectionRefs(answer));
  for (const u of numeric.untraceable) {
    const inLens = foldedLens.includes(u.literal.replace(/%$/, ""));
    flags.push({ rule: "numeric", span: u.literal, context: u.context, origin: originOf(foldedLens !== "" && inLens) });
  }

  return {
    flags,
    checked: {
      properNames: properNames.length,
      acronyms: acronyms.length,
      citations: citations.length,
      urlsEmails: urls.length,
      numericCandidates: numeric.artifactCandidates,
    },
    verified,
  };
}
