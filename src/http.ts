// HTTP helpers: JSON responses, security headers, origin and token checks.

import type { Server } from "bun";
import type { Config } from "./config.ts";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
};

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net 'unsafe-inline'",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src https://cdnjs.cloudflare.com",
].join("; ");

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
};

/** Ids are 12 lowercase hex chars; older rows may differ, so accept any alphanumeric. */
export const ID_PATTERN = /^[a-z0-9]+$/i;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
  });
}

export function requireJson(req: Request): boolean {
  return (req.headers.get("content-type") || "").includes("application/json");
}

export function contentLength(req: Request): number {
  return parseInt(req.headers.get("content-length") || "0");
}

/** Parse a JSON body; returns undefined when it is not valid JSON. */
export async function readJson<T>(req: Request): Promise<T | undefined> {
  try {
    return (await req.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * The engine trusts X-Forwarded-For only from loopback, i.e. from a reverse proxy on
 * the same machine, and takes its first entry. The proxy must overwrite the header with
 * the real client IP; a passed-through or appended visitor header defeats rate limits.
 */
export function getClientIP(req: Request, server: Server<unknown>): string {
  const directIP = server.requestIP(req)?.address || "unknown";
  if (directIP === "127.0.0.1" || directIP === "::1") {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
  }
  return directIP;
}

export function checkOrigin(req: Request, config: Config): boolean {
  if (!config.allowedOrigin) return !config.production;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  if (origin === config.allowedOrigin) return true;
  const allowed = new URL(config.allowedOrigin);
  const baseDomain = allowed.hostname.replace(/^[^.]+\./, "");
  if (origin === `${allowed.protocol}//${baseDomain}` || origin === `${allowed.protocol}//www.${baseDomain}`) return true;
  if (
    !config.production &&
    (origin.startsWith("http://localhost:") || origin.startsWith("http://100.") || origin.startsWith("http://192.168.") || origin.startsWith("http://10."))
  ) {
    return true;
  }
  return false;
}

/** /api/internal/* needs a shared token of at least 32 chars; without one the endpoints are inert. */
export function checkInternal(req: Request, config: Config): boolean {
  return config.internalApiToken.length >= 32 && req.headers.get("x-internal-token") === config.internalApiToken;
}
