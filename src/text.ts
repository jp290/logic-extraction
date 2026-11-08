// Small text utilities shared by the pipeline and the HTTP layer.

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function stripHTML(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, " ");
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function extractTitle(text: string): string {
  const firstLine = text.trim().split("\n")[0].trim();
  if (firstLine.length > 120) return firstLine.slice(0, 117) + "...";
  return firstLine || "Untitled Document";
}

/** Remove markdown code fences an LLM may wrap around JSON. */
export function stripJsonFence(raw: string): string {
  return raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

const CHUNK_SIZE = 80_000;
const CHUNK_OVERLAP = 5_000;

/** Fixed-size overlapping chunks (knowledge extraction). */
export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE + CHUNK_OVERLAP) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

/** Paragraph-aligned chunks of at most maxChars (phase-1 agents). */
export function chunkAtParagraphs(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > maxChars) {
      chunks.push(current);
      current = "";
    }
    current = current ? current + "\n\n" + para : para;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Merge new keys into a JSON grounding-report string. Throws on unparseable input. */
export function addToReport(reportJson: string, entries: Record<string, unknown>): string {
  const report = JSON.parse(reportJson) as Record<string, unknown>;
  return JSON.stringify(Object.assign(report, entries));
}
