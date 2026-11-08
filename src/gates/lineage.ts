// Transitive-root lineage for merge grounding. A merged extraction's prose is
// synthesized, so using it as gate truth lets level-1 fabrications become "parent
// truth" at level 2 (merge-chain provenance laundering, observed in a 12-paper
// merge experiment). Fidelity gates must verify
// against the ROOT (non-merged) ancestors instead: walk each parent's merge
// ancestry down to leaf extractions and ground against those.

import type { Database } from "bun:sqlite";

export interface RootDoc {
  id: string;
  title: string;
  logic_document: string;
  knowledge_extract: string | null;
  understanding_document: string | null;
  source_text: string | null;
  // True when this node is itself a merge result returned as a pseudo-root because
  // its lineage was unavailable (deleted parents or depth cap). Callers should
  // surface this in the grounding report — grounding truth is weaker here.
  merged_fallback: boolean;
}

const MAX_DEPTH = 12;

export function collectRootDocs(
  db: Database,
  extractionId: string,
  visited: Set<string> = new Set(),
  depth = 0,
  lost: { count: number } = { count: 0 }
): RootDoc[] {
  if (visited.has(extractionId)) return [];
  visited.add(extractionId);

  const row = db
    .query(
      "SELECT id, title, merge_id, logic_document, knowledge_extract, understanding_document, source_text FROM extractions WHERE id = ?"
    )
    .get(extractionId) as
    | (Omit<RootDoc, "merged_fallback"> & { merge_id: string | null })
    | null;
  if (!row) {
    // Deleted ancestor. Distinct from the visited-dedup empty return above: the
    // nearest surviving merge node must stand in as gate truth for this branch.
    lost.count++;
    return [];
  }

  if (row.merge_id && depth < MAX_DEPTH) {
    const merge = db
      .query("SELECT parent_a, parent_b FROM merges WHERE id = ?")
      .get(row.merge_id) as { parent_a: string; parent_b: string } | null;
    if (merge) {
      const lostBefore = lost.count;
      const roots = [
        ...collectRootDocs(db, merge.parent_a, visited, depth + 1, lost),
        ...collectRootDocs(db, merge.parent_b, visited, depth + 1, lost),
      ];
      if (lost.count > lostBefore) {
        // Part of the lineage is deleted — include this merged node as a FLAGGED
        // pseudo-root so the lost branch's content still has gate truth, and mark
        // the loss handled so ancestors don't re-add themselves.
        lost.count = lostBefore;
        const { merge_id, ...doc } = row;
        return [...roots, { ...doc, merged_fallback: true }];
      }
      if (roots.length > 0) return roots;
    }
  }

  const { merge_id, ...doc } = row;
  return [{ ...doc, merged_fallback: merge_id !== null }];
}

// Full deterministic-gate corpus: everything a quote in a merged document may
// legitimately be verbatim from — root lens documents (themselves quote-gated at
// extraction time) and the original source texts.
export function rootQuoteCorpus(roots: RootDoc[]): string {
  return roots
    .flatMap((d) => [
      d.logic_document,
      d.knowledge_extract ?? "",
      d.understanding_document ?? "",
      d.source_text ?? "",
    ])
    .filter(Boolean)
    .join("\n\n");
}
