// The HTTP application: a route table over the API plus static files. Everything a
// handler needs arrives through AppContext, so tests can build an app in-process.

import type { Server } from "bun";
import { createHash } from "crypto";
import { join, resolve } from "path";
import type { Engine } from "./engine.ts";
import { getClientIP, json, requireJson } from "./http.ts";
import { createRateLimits, JobSlots, ViewTracker } from "./limits.ts";
import type { AppContext, RequestContext, Route } from "./router.ts";
import { consultRoutes } from "./routes/consult.ts";
import { extractRoutes } from "./routes/extract.ts";
import { extractionRoutes } from "./routes/extractions.ts";
import { interviewRoutes } from "./routes/interviews.ts";
import { mergeRoutes } from "./routes/merges.ts";
import { packRoutes } from "./routes/packs.ts";
import { serveStatic } from "./routes/static.ts";
import { testRoutes } from "./routes/tests.ts";

// Order matters only where matchers overlap: /api/extractions/titles and …/okf must
// precede the /api/extractions/:id prefix route (both live in extractionRoutes).
const API_ROUTES: Route[] = [
  ...extractRoutes,
  ...extractionRoutes,
  ...packRoutes,
  ...consultRoutes,
  ...testRoutes,
  ...mergeRoutes,
  ...interviewRoutes,
];

export function createAppContext(engine: Engine): AppContext {
  return {
    ...engine,
    jobs: new JobSlots(),
    limits: createRateLimits(),
    views: new ViewTracker(),
    previewCache: new Map(),
    publicDir: resolve(join(import.meta.dir, "..", "public")),
    hashIP: (ip) => createHash("sha256").update(ip + engine.config.ipHashSalt).digest("hex").slice(0, 16),
  };
}

export function createFetchHandler(app: AppContext): (req: Request, server: Server<unknown>) => Promise<Response> {
  return async (req, server) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = getClientIP(req, server);
    const c: RequestContext = { req, url, path, app, ip, ipHash: app.hashIP(ip) };

    if (!path.startsWith("/api/")) return serveStatic(c);
    if (req.method === "POST" && !requireJson(req)) {
      return json({ error: "Content-Type must be application/json" }, 415);
    }
    for (const route of API_ROUTES) {
      if (route.method === req.method && route.match(path)) return route.handle(c);
    }
    return json({ error: "Not found" }, 404);
  };
}
