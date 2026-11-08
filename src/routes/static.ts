// Static files from public/ (path-traversal safe) and /e/:id lens pages, which get a
// server-rendered title, description, JSON-LD and a noscript summary for crawlers.

import { readFileSync } from "fs";
import { join, resolve } from "path";
import type { RequestContext } from "../router.ts";
import { CSP, ID_PATTERN, MIME, SECURITY_HEADERS } from "../http.ts";

const NO_CACHE = "no-store, no-cache, must-revalidate";

interface LensPageRow {
  title: string | null;
  topic_summary: string | null;
  doc_type: string | null;
  domain_tags: string | null;
  knowledge_extract: string | null;
  understanding_document: string | null;
  merge_id: string | null;
  word_count: number;
  created_at: string;
  author: string | null;
}

function parseTags(raw: string | null): string[] {
  try {
    return JSON.parse(raw || "[]") as string[];
  } catch {
    return [];
  }
}

function lensPage(publicDir: string, siteUrl: string, doc: LensPageRow): Response {
  let html = readFileSync(join(publicDir, "index.html"), "utf-8");
  const title = doc.title || "Untitled";
  const summary = doc.topic_summary || "";
  const docType = doc.doc_type || "Document";
  const tags = parseTags(doc.domain_tags);

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${title.replace(/[<>"]/g, "")} — Logic Extraction</title>`);
  html = html.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${summary.replace(/"/g, "&quot;").slice(0, 300)}">`);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "AnalysisNewsArticle",
    "name": title,
    "description": summary,
    "author": doc.author || undefined,
    "datePublished": doc.created_at,
    "wordCount": doc.word_count,
    "keywords": tags.join(", "),
    "articleSection": docType,
    "isPartOf": { "@type": "WebSite", "name": "Logic Extraction", "url": siteUrl },
  };
  const layers = [];
  if (doc.understanding_document) layers.push("Understanding Document");
  if (doc.knowledge_extract) layers.push("Knowledge Extract");
  layers.push("Logic Document");

  const noscriptContent = `
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<noscript>
<article>
<h1>${title.replace(/[<>]/g, "")}</h1>
<p><strong>Type:</strong> ${docType.replace(/[<>"&]/g, "")} ${doc.merge_id ? "(Merge Result)" : "(Source Extraction)"}</p>
<p><strong>Summary:</strong> ${summary.replace(/[<>"&]/g, "")}</p>
${tags.length > 0 ? `<p><strong>Topics:</strong> ${tags.map((t) => String(t).replace(/[<>"&]/g, "")).join(", ")}</p>` : ""}
<p><strong>Layers available:</strong> ${layers.join(", ")}</p>
<p>Enable JavaScript to view the full interactive analysis.</p>
</article>
</noscript>`;
  html = html.replace("</head>", `${noscriptContent}\n</head>`);

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_CACHE, "Content-Security-Policy": CSP, ...SECURITY_HEADERS },
  });
}

export async function serveStatic(c: RequestContext): Promise<Response> {
  const { publicDir, db } = c.app;
  let filePath: string;
  if (c.path === "/" || c.path === "/logic-extraction") {
    filePath = join(publicDir, "index.html");
  } else if (c.path.startsWith("/e/")) {
    const docId = c.path.split("/")[2];
    if (docId && ID_PATTERN.test(docId)) {
      const doc = db
        .query<LensPageRow, [string]>(
          `SELECT title, topic_summary, doc_type, domain_tags, logic_document, knowledge_extract, understanding_document, merge_id,
                  word_count, created_at, author
           FROM extractions WHERE id = ? AND flagged = 0 AND status = 'complete'`
        )
        .get(docId);
      if (doc) return lensPage(publicDir, c.app.config.publicUrl, doc);
    }
    filePath = join(publicDir, "index.html");
  } else {
    filePath = resolve(join(publicDir, c.path));
    if (!filePath.startsWith(publicDir + "/")) return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const ext = "." + filePath.split(".").pop();
  const headers: Record<string, string> = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": NO_CACHE,
    ...SECURITY_HEADERS,
  };
  if (ext === ".html") headers["Content-Security-Policy"] = CSP;
  return new Response(file, { headers });
}
