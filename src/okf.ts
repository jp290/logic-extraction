// OKF v0.1 static export — serialize an already-gated lens (LD/KE/UD) into an
// Open Knowledge Format bundle (directory of markdown + YAML frontmatter).
// Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
//
// Constraints: static only, no write-back, no retrieval path, source-gated only
// (stored gated docs are reused verbatim — never regenerated). The bundle is a
// portable, source-gated reasoning package.

export interface OkfRow {
  id: string;
  title: string;
  author: string | null;
  doc_type: string | null;
  topic_summary: string | null;
  domain_tags: string | null; // JSON array string
  created_at: string;
  model: string | null;
  logic_document: string | null;
  knowledge_extract: string | null;
  understanding_document: string | null;
  grounding_report: string | null; // JSON string
}

export interface OkfFile {
  path: string; // relative path within the bundle
  content: string;
}

export interface OkfBundle {
  slug: string;
  files: OkfFile[];
}

function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "lens";
}

// Double-quoted YAML scalar — escapes the characters that break a quoted flow
// scalar. Sufficient for our controlled fields (no multiline values).
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r]+/g, " ").trim()}"`;
}

function yamlTags(tags: string[]): string {
  if (tags.length === 0) return "[]";
  return `[${tags.map(yamlString).join(", ")}]`;
}

function parseTags(domainTags: string | null): string[] {
  if (!domainTags) return [];
  try {
    const arr = JSON.parse(domainTags);
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

interface Frontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
}

function frontmatter(fm: Frontmatter): string {
  const lines: string[] = ["---"];
  lines.push(`type: ${yamlString(fm.type)}`);
  if (fm.title !== undefined) lines.push(`title: ${yamlString(fm.title)}`);
  if (fm.description !== undefined) lines.push(`description: ${yamlString(fm.description)}`);
  if (fm.resource !== undefined) lines.push(`resource: ${yamlString(fm.resource)}`);
  if (fm.tags !== undefined) lines.push(`tags: ${yamlTags(fm.tags)}`);
  if (fm.timestamp !== undefined) lines.push(`timestamp: ${yamlString(fm.timestamp)}`);
  lines.push("---");
  return lines.join("\n");
}

function groundingSummary(report: string | null): string {
  if (!report) return "No stored grounding report (lens predates the source-grounding gate or was extracted without it).";
  try {
    const g = JSON.parse(report) as {
      entityScore?: number;
      entityTotal?: number;
      ungroundedEntities?: unknown[];
    };
    if (typeof g.entityScore !== "number" || typeof g.entityTotal !== "number") {
      return "Grounding report present but unrecognized shape.";
    }
    const grounded = Math.round(g.entityScore * g.entityTotal);
    const ungrounded = Array.isArray(g.ungroundedEntities) ? g.ungroundedEntities.length : g.entityTotal - grounded;
    return [
      `Entity grounding score: ${(g.entityScore * 100).toFixed(1)}% (${grounded}/${g.entityTotal} entities traced to the source text).`,
      `Ungrounded spans flagged: ${ungrounded}.`,
    ].join("\n");
  } catch {
    return "Grounding report present but unparseable.";
  }
}

// Build an OKF bundle from a stored, gated extraction row. Emits only the layers
// that exist; never fabricates or regenerates content.
/** `baseUrl` is the public site the canonical `resource` link points to. */
export function buildOkfBundle(row: OkfRow, baseUrl: string): OkfBundle {
  const slug = slugify(row.title);
  const resource = `${baseUrl}/e/${row.id}`;
  const tags = parseTags(row.domain_tags);
  const description = (row.topic_summary || "").trim();
  const ts = row.created_at;
  const files: OkfFile[] = [];

  // Sub-documents — only the layers that are present.
  const hasLD = !!(row.logic_document && row.logic_document.trim());
  const hasKE = !!(row.knowledge_extract && row.knowledge_extract.trim());
  const hasUD = !!(row.understanding_document && row.understanding_document.trim());

  if (hasLD) {
    files.push({
      path: "logic-document.md",
      content:
        frontmatter({ type: "Reasoning Dynamics", title: `${row.title} — Logic Document`, resource, tags, timestamp: ts }) +
        "\n\n[← Lens index](./index.md)\n\n" +
        (row.logic_document as string).trim() +
        "\n",
    });
  }
  if (hasKE) {
    files.push({
      path: "knowledge-extract.md",
      content:
        frontmatter({ type: "Knowledge Extract", title: `${row.title} — Knowledge Extract`, resource, tags, timestamp: ts }) +
        "\n\n[← Lens index](./index.md)\n\n" +
        (row.knowledge_extract as string).trim() +
        "\n",
    });
  }
  if (hasUD) {
    files.push({
      path: "understanding.md",
      content:
        frontmatter({ type: "Understanding", title: `${row.title} — Understanding`, resource, tags, timestamp: ts }) +
        "\n\n[← Lens index](./index.md)\n\n" +
        (row.understanding_document as string).trim() +
        "\n",
    });
  }

  // index.md — the Lens concept, links to every present layer.
  const layerLinks: string[] = [];
  if (hasLD) layerLinks.push("- [Logic Document](./logic-document.md) — *Reasoning Dynamics*: how this source reasons.");
  if (hasKE) layerLinks.push("- [Knowledge Extract](./knowledge-extract.md) — *Knowledge Extract*: the source's facts and claims.");
  if (hasUD) layerLinks.push("- [Understanding](./understanding.md) — *Understanding*: the synthesized worldview.");

  const meta: string[] = [];
  if (row.author) meta.push(`**Source author:** ${row.author}`);
  if (row.doc_type) meta.push(`**Document type:** ${row.doc_type}`);

  const indexBody = [
    `# ${row.title}`,
    meta.length ? "\n" + meta.join("  \n") : "",
    description ? "\n" + description : "",
    "\n## Layers\n",
    layerLinks.join("\n"),
    "\n## Provenance\n",
    "- [Change log](./log.md)",
    "",
    "This is a **portable, source-gated reasoning bundle** exported in Open Knowledge Format " +
      "(OKF v0.1). Every layer was distilled from the cited source and passed source-grounding " +
      "checks before export. The bundle is a static, read-only artifact — provenance is the point.",
    "",
    `Canonical lens: <${resource}>`,
  ].join("\n");

  files.unshift({
    path: "index.md",
    content:
      frontmatter({ type: "Lens", title: row.title, description, resource, tags, timestamp: ts }) +
      "\n\n" +
      indexBody +
      "\n",
  });

  // log.md — change history / provenance record.
  const logBody = [
    "# Change Log",
    "",
    `- **${ts}** — Lens extracted from source.`,
    `- **${ts}** — Source-grounding gate run; layers below cleared for export.`,
    "",
    "## Provenance",
    "",
    `- **Model:** ${row.model || "unknown"}`,
    `- **Extraction timestamp:** ${ts}`,
    `- **Canonical lens:** <${resource}>`,
    "",
    "## Grounding summary",
    "",
    groundingSummary(row.grounding_report),
    "",
    "## Export notes",
    "",
    "Static OKF v0.1 export of already-gated content. No content was regenerated for",
    "this bundle. The artifact is read-only: consumers do not write back to it.",
    "",
  ].join("\n");

  files.push({
    path: "log.md",
    content: frontmatter({ type: "Change Log", title: `${row.title} — Change Log`, resource, timestamp: ts }) + "\n\n" + logBody,
  });

  return { slug, files };
}

// ── Validation (used by the round-trip test and any consumer) ────────────────

export interface OkfValidationIssue {
  file: string;
  issue: string;
}

const FM_RE = /^---\n([\s\S]*?)\n---/;

function parseFrontmatterBlock(content: string): { fields: Record<string, string>; ok: boolean } {
  const m = content.match(FM_RE);
  if (!m) return { fields: {}, ok: false };
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) return { fields, ok: false };
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fields, ok: true };
}

// Validate a bundle as OKF v0.1: every concept file carries `type` in well-formed
// frontmatter, an index.md exists, and every relative markdown link resolves.
export function validateOkfBundle(files: OkfFile[]): OkfValidationIssue[] {
  const issues: OkfValidationIssue[] = [];
  const names = new Set(files.map((f) => f.path));

  if (!names.has("index.md")) issues.push({ file: "(bundle)", issue: "missing required index.md" });

  for (const f of files) {
    if (!f.path.endsWith(".md")) continue;
    const { fields, ok } = parseFrontmatterBlock(f.content);
    if (!ok) {
      issues.push({ file: f.path, issue: "malformed or missing YAML frontmatter" });
      continue;
    }
    if (!fields.type) issues.push({ file: f.path, issue: "missing required `type` field" });

    // Relative markdown links must resolve to a file in the bundle.
    const linkRe = /\]\((\.\/[^)]+)\)/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(f.content)) !== null) {
      const target = lm[1].replace(/^\.\//, "");
      if (!names.has(target)) issues.push({ file: f.path, issue: `dangling link to ${lm[1]}` });
    }
  }
  return issues;
}

// ── tar.gz packaging (POSIX ustar, dependency-free) ──────────────────────────

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

function tarHeader(name: string, size: number, mtime: number): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (str: string, offset: number, max: number) => {
    const bytes = enc.encode(str);
    h.set(bytes.subarray(0, max), offset);
  };
  put(name, 0, 100);
  put("0000644\0", 100, 8); // mode
  put("0000000\0", 108, 8); // uid
  put("0000000\0", 116, 8); // gid
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  put("        ", 148, 8); // checksum placeholder (spaces)
  h[156] = 0x30; // typeflag '0' = regular file
  put("ustar\0", 257, 6);
  put("00", 263, 2);

  // checksum = sum of all header bytes with the checksum field as spaces
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

// Pack a bundle into a gzipped tar archive rooted at `<rootDir>/`. mtime is taken
// from the bundle (created_at epoch) so the same lens yields a stable archive.
export function bundleToTarGz(bundle: OkfBundle, rootDir: string, mtimeEpoch: number): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const f of bundle.files) {
    const data = enc.encode(f.content);
    blocks.push(tarHeader(`${rootDir}/${f.path}`, data.length, mtimeEpoch));
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks = end of archive

  let total = 0;
  for (const b of blocks) total += b.length;
  const tar = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    tar.set(b, off);
    off += b.length;
  }
  return Bun.gzipSync(tar);
}

export function createdAtEpoch(createdAt: string): number {
  const ms = Date.parse(createdAt.includes("T") ? createdAt : createdAt.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}
