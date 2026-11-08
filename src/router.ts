// Route-table primitives shared by app.ts and the route modules.

import type { Engine } from "./engine.ts";
import type { JobSlots, RateLimits, ViewTracker } from "./limits.ts";

export interface AppContext extends Engine {
  jobs: JobSlots;
  limits: RateLimits;
  views: ViewTracker;
  previewCache: Map<string, { result: unknown; timestamp: number }>;
  publicDir: string;
  hashIP(ip: string): string;
}

export interface RequestContext {
  req: Request;
  url: URL;
  path: string;
  app: AppContext;
  /** Client IP (X-Forwarded-For honoured from loopback only) and its salted hash. */
  ip: string;
  ipHash: string;
}

export interface Route {
  method: "GET" | "POST";
  match: (path: string) => boolean;
  handle: (c: RequestContext) => Response | Promise<Response>;
}

export const exact = (p: string) => (path: string): boolean => path === p;
export const prefix = (p: string) => (path: string): boolean => path.startsWith(p);
export const pattern = (r: RegExp) => (path: string): boolean => r.test(path);
