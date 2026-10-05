// Thin Klarna REST client: one request function over fetch, HTTP Basic auth,
// Klarna-Idempotency-Key on writes, and error mapping to Klarna's documented
// error object (error_code, error_messages / error_message, correlation_id).
//
// fetch is injectable so tests (and any host) can run it without network.
// Credentials live only in the Authorization header; they are never put into
// error messages, and anything that looks like one is redacted defensively.

import { loadConfig, type KlarnaConfig } from "./config.js";

export type FetchFn = typeof fetch;

export interface KlarnaRequest {
  method: "GET" | "POST" | "PATCH";
  /** Path including the API prefix, e.g. /ordermanagement/v1/orders/abc. */
  path: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
  /** Sent as the Klarna-Idempotency-Key header. */
  idempotencyKey?: string;
  /** Accept header; defaults to application/json. */
  accept?: string;
}

export interface KlarnaResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON, raw text for non-JSON bodies, or null for empty bodies. */
  body: any;
}

export interface KlarnaClient {
  request(req: KlarnaRequest): Promise<KlarnaResponse>;
  /** Region and environment, for tool descriptions and results. Throws if config is invalid. */
  describe(): { region: string; env: string; baseUrl: string };
}

/** A non-2xx answer from Klarna, mapped to the documented error fields. */
export class KlarnaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string | undefined,
    public readonly errorMessages: string[],
    public readonly correlationId: string | undefined,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(
      `Klarna API ${method} ${path} failed with HTTP ${status}` +
      (errorCode ? ` ${errorCode}` : "") +
      (errorMessages.length ? `: ${errorMessages.join("; ")}` : "") +
      (correlationId ? ` (correlation_id ${correlationId})` : ""),
    );
    this.name = "KlarnaApiError";
  }

  toJSON() {
    return {
      http_status: this.status,
      error_code: this.errorCode ?? null,
      error_messages: this.errorMessages,
      correlation_id: this.correlationId ?? null,
      request: `${this.method} ${this.path}`,
      hint: hintFor(this.status),
    };
  }
}

function hintFor(status: number): string | undefined {
  if (status === 401) return "Credentials missing or wrong. Check KLARNA_USERNAME/KLARNA_PASSWORD, and that they belong to the selected KLARNA_ENV and KLARNA_REGION.";
  if (status === 403) return "Not allowed. The operation is not permitted in the order's current state, or the credentials lack access. Klarna can also return 403 for an invalid path.";
  if (status === 404) return "Not found. Check the id, and that it belongs to the selected KLARNA_ENV and KLARNA_REGION.";
  if (status === 429) return "Rate limited by Klarna. Wait before retrying.";
  if (status >= 500) return "Klarna server error. Reads are safe to retry; retry writes only with the same idempotency_key.";
  return undefined;
}

/** Strip anything that looks like an Authorization value or a Klarna API key. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text
    .replace(/(authorization["']?\s*[:=]\s*["']?)(basic|bearer)\s+[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._:-]{8,}/g, "$1 [REDACTED]")
    .replace(/klarna_(live|test)_[A-Za-z0-9_]+/g, "klarna_$1_[REDACTED]");
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

function buildUrl(baseUrl: string, path: string, query?: KlarnaRequest["query"]): string {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      // OpenAPI style=form, explode=true: repeat the parameter.
      for (const item of v) url.searchParams.append(k, item);
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

function toErrorMessages(body: any): string[] {
  if (!body || typeof body !== "object") {
    return typeof body === "string" && body.trim() ? [body.trim().slice(0, 500)] : [];
  }
  if (Array.isArray(body.error_messages)) return body.error_messages.map(String);
  if (typeof body.error_message === "string") return [body.error_message];
  return [];
}

export function createKlarnaClient(
  opts: { fetch?: FetchFn; config?: () => KlarnaConfig } = {},
): KlarnaClient {
  const doFetch: FetchFn = opts.fetch ?? ((...a) => fetch(...a));
  const getConfig = opts.config ?? (() => loadConfig());
  let cached: KlarnaConfig | null = null;
  const config = () => (cached ??= getConfig());

  return {
    describe() {
      const c = config();
      return { region: c.region, env: c.env, baseUrl: c.baseUrl };
    },

    async request(req) {
      const c = config();
      const headers: Record<string, string> = {
        Authorization: c.authorization,
        Accept: req.accept ?? "application/json",
        "User-Agent": "klarna-mcp/0.1.0",
      };
      if (req.body !== undefined) headers["Content-Type"] = "application/json";
      if (req.idempotencyKey) headers["Klarna-Idempotency-Key"] = req.idempotencyKey;

      const url = buildUrl(c.baseUrl, req.path, req.query);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: req.method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(redact(`Network error calling Klarna ${req.method} ${req.path}: ${msg}`, c.secrets));
      }

      const body = await parseBody(res);
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { outHeaders[k.toLowerCase()] = v; });

      if (!res.ok) {
        const correlationId =
          (body && typeof body === "object" && (body.correlation_id ?? body.error_id)) ||
          outHeaders["klarna-correlation-id"] ||
          undefined;
        throw new KlarnaApiError(
          res.status,
          body && typeof body === "object" ? body.error_code : undefined,
          toErrorMessages(body).map(m => redact(m, c.secrets)),
          correlationId,
          req.method,
          req.path,
        );
      }
      return { status: res.status, headers: outHeaders, body };
    },
  };
}
