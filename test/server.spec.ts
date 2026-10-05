// Server tests: drive the real MCP wire (in-memory transport) and the real
// Klarna client against a mocked fetch. Proves tool registration, the
// read-only default, zod schemas, the exact HTTP requests sent to Klarna
// (method, URL, headers, body), response mapping and error mapping, all
// without network or credentials.

import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKlarnaServer } from "../src/server.js";
import { createKlarnaClient, type FetchFn } from "../src/klarna.js";
import { loadConfig } from "../src/config.js";

const USER = "PK12345_abcdef";
const PASS = "s3cret-shared-secret";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

interface Call { url: URL; method: string; headers: Record<string, string>; body: any }

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

function mockFetch(reply: Reply | ((c: Call) => Reply) = { json: {} }) {
  const calls: Call[] = [];
  const fn: FetchFn = async (input: any, init: any = {}) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init.method ?? "GET",
      headers: { ...(init.headers ?? {}) },
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = typeof reply === "function" ? reply(call) : reply;
    const headers = new Headers(r.headers ?? {});
    let body: string | null = null;
    if (r.json !== undefined) { body = JSON.stringify(r.json); headers.set("content-type", "application/json"); }
    else if (r.text !== undefined) { body = r.text; if (!headers.has("content-type")) headers.set("content-type", "text/csv"); }
    return new Response(body, { status: r.status ?? 200, headers });
  };
  return { fn, calls };
}

async function connect(fetchFn: FetchFn, opts: { enableWrites?: boolean; env?: Record<string, string> } = {}) {
  const env = { KLARNA_USERNAME: USER, KLARNA_PASSWORD: PASS, ...(opts.env ?? {}) };
  const client = createKlarnaClient({ fetch: fetchFn, config: () => loadConfig(env) });
  const server = createKlarnaServer({ client, enableWrites: opts.enableWrites ?? false });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), mcp.connect(clientT)]);
  return mcp;
}

const text = (r: any) => r.content[0].text as string;
const json = (r: any) => JSON.parse(text(r));

const READ_TOOLS = [
  "get_dispute", "get_order", "get_capture", "get_payment_session", "get_payout",
  "get_payout_report_csv", "get_payout_summary", "get_payouts_summary_report_csv", "get_refund",
  "list_captures", "list_disputes", "list_payouts", "list_transactions",
].sort();
const WRITE_TOOLS = [
  "cancel_order", "capture_order", "extend_authorization_time", "refund_order", "release_remaining_authorization",
].sort();

describe("registration and safety model", () => {
  it("registers only read tools by default", async () => {
    const mcp = await connect(mockFetch().fn);
    const { tools } = await mcp.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(READ_TOOLS);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it("does not register writes from the env flag unless it is exactly true", async () => {
    const prev = process.env.KLARNA_ENABLE_WRITES;
    process.env.KLARNA_ENABLE_WRITES = "yes";
    try {
      const client = createKlarnaClient({ fetch: mockFetch().fn, config: () => loadConfig({ KLARNA_USERNAME: USER, KLARNA_PASSWORD: PASS }) });
      const server = createKlarnaServer({ client });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const mcp = new Client({ name: "t", version: "0" });
      await Promise.all([server.connect(b), mcp.connect(a)]);
      const { tools } = await mcp.listTools();
      expect(tools.some(t => WRITE_TOOLS.includes(t.name))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.KLARNA_ENABLE_WRITES; else process.env.KLARNA_ENABLE_WRITES = prev;
    }
  });

  it("registers write tools with write annotations when enabled", async () => {
    const mcp = await connect(mockFetch().fn, { enableWrites: true });
    const { tools } = await mcp.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    for (const n of WRITE_TOOLS) expect(byName[n]!.annotations?.readOnlyHint).toBe(false);
    for (const n of ["capture_order", "refund_order", "cancel_order", "release_remaining_authorization"]) {
      expect(byName[n]!.annotations?.destructiveHint).toBe(true);
    }
    expect(byName.extend_authorization_time!.annotations?.destructiveHint).toBe(false);
  });

  it("sends HTTP Basic auth to the playground EU host by default", async () => {
    const f = mockFetch({ json: { order_id: "o1" } });
    const mcp = await connect(f.fn);
    await mcp.callTool({ name: "get_order", arguments: { order_id: "o1" } });
    expect(f.calls[0]!.url.origin).toBe("https://api.playground.klarna.com");
    expect(f.calls[0]!.headers.Authorization).toBe(AUTH);
    expect(f.calls[0]!.headers.Accept).toBe("application/json");
  });

  it("uses the regional production host", async () => {
    const f = mockFetch({ json: {} });
    const mcp = await connect(f.fn, { env: { KLARNA_REGION: "na", KLARNA_ENV: "production" } });
    await mcp.callTool({ name: "get_order", arguments: { order_id: "o1" } });
    expect(f.calls[0]!.url.origin).toBe("https://api-na.klarna.com");
  });

  it("returns a clear error, without calling Klarna, when credentials are missing", async () => {
    const f = mockFetch();
    const client = createKlarnaClient({ fetch: f.fn, config: () => loadConfig({}) });
    const server = createKlarnaServer({ client, enableWrites: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), mcp.connect(a)]);
    const r: any = await mcp.callTool({ name: "get_order", arguments: { order_id: "o1" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/KLARNA_USERNAME/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("Order Management reads", () => {
  it("get_order", async () => {
    const f = mockFetch({ json: { order_id: "abc", status: "AUTHORIZED", order_amount: 10000 } });
    const mcp = await connect(f.fn);
    const r = await mcp.callTool({ name: "get_order", arguments: { order_id: "abc" } });
    expect(f.calls[0]!.method).toBe("GET");
    expect(f.calls[0]!.url.pathname).toBe("/ordermanagement/v1/orders/abc");
    expect(json(r).order_amount).toBe(10000);
  });

  it("get_order encodes the id in the path", async () => {
    const f = mockFetch({ json: {} });
    const mcp = await connect(f.fn);
    await mcp.callTool({ name: "get_order", arguments: { order_id: "a/../b" } });
    expect(f.calls[0]!.url.pathname).toBe("/ordermanagement/v1/orders/a%2F..%2Fb");
  });

  it("list_captures", async () => {
    const f = mockFetch({ json: [{ capture_id: "c1", captured_amount: 5000 }] });
    const mcp = await connect(f.fn);
    const r = await mcp.callTool({ name: "list_captures", arguments: { order_id: "abc" } });
    expect(f.calls[0]!.url.pathname).toBe("/ordermanagement/v1/orders/abc/captures");
    expect(json(r)[0].capture_id).toBe("c1");
  });

  it("get_capture", async () => {
    const f = mockFetch({ json: { capture_id: "c1" } });
    const mcp = await connect(f.fn);
    await mcp.callTool({ name: "get_capture", arguments: { order_id: "abc", capture_id: "c1" } });
    expect(f.calls[0]!.url.pathname).toBe("/ordermanagement/v1/orders/abc/captures/c1");
  });

  it("get_refund", async () => {
    const f = mockFetch({ json: { refund_id: "r1", refunded_amount: 2500 } });
    const mcp = await connect(f.fn);
    const r = await mcp.callTool({ name: "get_refund", arguments: { order_id: "abc", refund_id: "r1" } });
    expect(f.calls[0]!.url.pathname).toBe("/ordermanagement/v1/orders/abc/refunds/r1");
    expect(json(r).refunded_amount).toBe(2500);
  });
});

describe("Settlements", () => {
  it("list_payouts passes filters and pagination", async () => {
    const f = mockFetch({ json: { payouts: [], pagination: { count: 0 } } });
    const mcp = await connect(f.fn);
    await mcp.callTool({ name: "list_payouts", arguments: {
      start_date: "2026-09-01T00:00:00Z", end_date: "2026-09-30T23:59:59Z", currency_code: "SEK", size: 50, offset: 100,
    } });
    const u = f.calls[0]!.url;
    expect(u.pathname).toBe("/settlements/v1/payouts");
    expect(u.searchParams.get("start_date")).toBe("2026-09-01T00:00:00Z");
    expect(u.searchParams.get("end_date")).toBe("2026-09-30T23:59:59Z");
    expect(u.searchParams.get("currency_code")).toBe("SEK");
    expect(u.searchParams.get("size")).toBe("50");
    expect(u.searchParams.get("offset")).toBe("100");
  });

  it("list_payouts omits unset filters", async () => {
    const f = mockFetch({ json: { payouts: [] } });
    const mcp = await connect(f.fn);
    await mcp.callTool({ name: "list_payouts", arguments: {} });
    expect([...f.calls[0]!.url.searchParams.keys()]).toEqual([]);
  });

  it("list_payouts rejects size over 500", async () => {
    const f = mockFetch();
    const mcp = await connect(f.fn);
    const r: any = await mcp.callTool({ name: "list_payouts", arguments: { size: 501 } });
    expect(r.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("get_payout", async () => {
    const f = mockFetch({ json: { payment_reference: "XISA1234", totals: { settlement_amount: 99000 } } });
    const mcp = await connect(f.fn);
    const r = await mcp.callTool({ name: "get_payout", arguments: { payment_reference: "XISA1234" } });
    expect(f.calls[0]!.url.pathname).toBe("/settlements/v1/payouts/XISA1234");
    expect(json(r).totals.settlement_amount).toBe(99000);
  });

  it("get_payout_summary requires both dates", async () => {
    const f = mockFetch({ json: [{ summary_settlement_currency: "EUR" }] });
    const mcp = await connect(f.fn);
    const bad: any = await mcp.callTool({ name: "get_payout_summary", arguments: { start_date: "2026-09-01T00:00:00Z" } });
    expect(bad.isError).toBe(true);
    await mcp.callTool({ name: "get_payout_summary", arguments: { start_date: "2026-09-01T00:00:00Z", end_date: "2026-09-30T23:59:59Z" } });
    expect(f.calls[0]!.url.pathname).toBe("/settlements/v1/payouts/summary");
    expect(f.calls[0]!.url.searchParams.get("end_date")).toBe("2026-09-30T23:59:59Z");
  });

  it("list_transactions filters by payout and order", async () => {
    const f = mockFetch({ json: { transactions: [{ type: "SALE", amount: 10000 }], pagination: { count: 1 } } });
    const mcp = await connect(f.fn);
    const r = await mcp.callTool({ name: "list_transactions", arguments: { payment_reference: "XISA1234", order_id: "abc", size: 500 } });
    const u = f.calls[0]!.url;
    expect(u.pathname).toBe("/settlements/v1/transactions");
    expect(u.searchParams.get("payment_reference")).toBe("XISA1234");
    expect(u.searchParams.get("order_id")).toBe("abc");
    expect(u.searchParams.get("size")).toBe("500");
    expect(json(r).transactions[0].amount).toBe(10000);
  });

  it("get_payout_report_csv returns CSV text and asks for text/csv", async () => {
    const f = mockFetch({ text: "type,amount\nSALE,10000\n" });
    const mcp = await connect(f.fn);
    const r = await mcp.callTool({ name: "get_payout_report_csv", arguments: { payment_reference: "XISA1234" } });
    expect(f.calls[0]!.url.pathname).toBe("/settlements/v1/reports/payout-with-transactions");
    expect(f.calls[0]!.url.searchParams.get("payment_reference")).toBe("XISA1234");
    expect(f.calls[0]!.headers.Accept).toBe("text/csv");
    expect(text(r)).toBe("type,amount\nSALE,10000\n");
  });

  it("get_payouts_summary_report_csv", async () => {
    const f = mockFetch({ text: "a,b\n1,2\n" });
    const mcp = await connect(f.fn);
    const r = await mcp.callTool({ name: "get_payouts_summary_report_csv", arguments: { start_date: "2026-09-01T00:00:00Z", end_date: "2026-09-30T23:59:59Z" } });
    expect(f.calls[0]!.url.pathname).toBe("/settlements/v1/reports/payouts-summary-with-transactions");
    expect(f.calls[0]!.url.searchParams.get("start_date")).toBe("2026-09-01T00:00:00Z");
    expect(text(r)).toContain("1,2");
  });

  it("truncates very large CSV reports", async () => {
    const big = "x".repeat(500_000);
    const mcp = await connect(mockFetch({ text: big }).fn);
    const r = await mcp.callTool({ name: "get_payouts_summary_report_csv", arguments: { start_date: "2026-01-01T00:00:00Z", end_date: "2026-12-31T23:59:59Z" } });
    expect(text(r)).toMatch(/\[truncated: 100000 more characters/);
  });
});

describe("Disputes and Payments", () => {
  it("list_disputes repeats array params (form, explode)", async () => {
    const f = mockFetch({ json: { disputes: [], pagination: { count: 0 } } });
    const mcp = await connect(f.fn);
    await mcp.callTool({ name: "list_disputes", arguments: {
      state: ["INITIATED", "REPRESENTMENT"], order_ids: ["o1"], sort_by: ["-created_at"],
      created_at_start: "2026-09-01T00:00:00Z", size: 20, starting_after: "cursor1",
    } });
    const u = f.calls[0]!.url;
    expect(u.pathname).toBe("/v4/payment/disputes");
    expect(u.searchParams.getAll("state")).toEqual(["INITIATED", "REPRESENTMENT"]);
    expect(u.searchParams.getAll("order_ids")).toEqual(["o1"]);
    expect(u.searchParams.get("sort_by")).toBe("-created_at");
    expect(u.searchParams.get("created_at_start")).toBe("2026-09-01T00:00:00Z");
    expect(u.searchParams.get("starting_after")).toBe("cursor1");
  });

  it("list_disputes rejects an unknown state", async () => {
    const f = mockFetch();
    const mcp = await connect(f.fn);
    const r: any = await mcp.callTool({ name: "list_disputes", arguments: { state: ["OPEN"] } });
    expect(r.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("get_dispute", async () => {
    const f = mockFetch({ json: { payment_dispute_id: "d1", state: "INITIATED" } });
    const mcp = await connect(f.fn);
    const r = await mcp.callTool({ name: "get_dispute", arguments: { payment_dispute_id: "d1" } });
    expect(f.calls[0]!.url.pathname).toBe("/v4/payment/disputes/d1");
    expect(json(r).state).toBe("INITIATED");
  });

  it("get_payment_session", async () => {
    const f = mockFetch({ json: { status: "complete", order_amount: 10000 } });
    const mcp = await connect(f.fn);
    const r = await mcp.callTool({ name: "get_payment_session", arguments: { session_id: "s1" } });
    expect(f.calls[0]!.method).toBe("GET");
    expect(f.calls[0]!.url.pathname).toBe("/payments/v1/sessions/s1");
    expect(json(r).status).toBe("complete");
  });
});

describe("Order Management writes", () => {
  let f: ReturnType<typeof mockFetch>;
  let mcp: Client;

  beforeEach(async () => {
    f = mockFetch(c => {
      if (c.url.pathname.endsWith("/captures")) return { status: 201, headers: { "Capture-Id": "cap-1", Location: "https://x/captures/cap-1" } };
      if (c.url.pathname.endsWith("/refunds")) return { status: 201, headers: { "Refund-Id": "ref-1", Location: "https://x/refunds/ref-1" } };
      return { status: 204 };
    });
    mcp = await connect(f.fn, { enableWrites: true });
  });

  it("capture_order posts the body with a generated idempotency key", async () => {
    const r = await mcp.callTool({ name: "capture_order", arguments: {
      order_id: "abc", captured_amount: 10000, reference: "cap-ref",
      order_lines: [{ name: "Shoe", quantity: 1, unit_price: 10000, total_amount: 10000 }],
      shipping_info: [{ shipping_company: "DHL", tracking_number: "123" }],
    } });
    const c = f.calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url.pathname).toBe("/ordermanagement/v1/orders/abc/captures");
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(c.headers["Klarna-Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.body).toEqual({
      captured_amount: 10000, reference: "cap-ref",
      order_lines: [{ name: "Shoe", quantity: 1, unit_price: 10000, total_amount: 10000 }],
      shipping_info: [{ shipping_company: "DHL", tracking_number: "123" }],
    });
    const out = json(r);
    expect(out.capture_id).toBe("cap-1");
    expect(out.idempotency_key).toBe(c.headers["Klarna-Idempotency-Key"]);
    expect(out.environment).toBe("playground");
  });

  it("capture_order reuses a supplied idempotency key", async () => {
    await mcp.callTool({ name: "capture_order", arguments: { order_id: "abc", captured_amount: 1, idempotency_key: "key-1" } });
    expect(f.calls[0]!.headers["Klarna-Idempotency-Key"]).toBe("key-1");
    expect(f.calls[0]!.body).toEqual({ captured_amount: 1 });
  });

  it("capture_order rejects negative and fractional amounts", async () => {
    const neg: any = await mcp.callTool({ name: "capture_order", arguments: { order_id: "abc", captured_amount: -1 } });
    const frac: any = await mcp.callTool({ name: "capture_order", arguments: { order_id: "abc", captured_amount: 10.5 } });
    expect(neg.isError).toBe(true);
    expect(frac.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("refund_order", async () => {
    const r = await mcp.callTool({ name: "refund_order", arguments: { order_id: "abc", refunded_amount: 2500, description: "Return" } });
    const c = f.calls[0]!;
    expect(c.url.pathname).toBe("/ordermanagement/v1/orders/abc/refunds");
    expect(c.body).toEqual({ refunded_amount: 2500, description: "Return" });
    expect(c.headers["Klarna-Idempotency-Key"]).toBeTruthy();
    expect(json(r).refund_id).toBe("ref-1");
  });

  it("extend_authorization_time", async () => {
    const r = await mcp.callTool({ name: "extend_authorization_time", arguments: { order_id: "abc" } });
    const c = f.calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url.pathname).toBe("/ordermanagement/v1/orders/abc/extend-authorization-time");
    expect(c.body).toBeUndefined();
    expect(c.headers["Klarna-Idempotency-Key"]).toBeTruthy();
    expect(json(r).http_status).toBe(204);
  });

  it("cancel_order", async () => {
    await mcp.callTool({ name: "cancel_order", arguments: { order_id: "abc", idempotency_key: "k2" } });
    expect(f.calls[0]!.url.pathname).toBe("/ordermanagement/v1/orders/abc/cancel");
    expect(f.calls[0]!.headers["Klarna-Idempotency-Key"]).toBe("k2");
  });

  it("release_remaining_authorization", async () => {
    await mcp.callTool({ name: "release_remaining_authorization", arguments: { order_id: "abc" } });
    expect(f.calls[0]!.method).toBe("POST");
    expect(f.calls[0]!.url.pathname).toBe("/ordermanagement/v1/orders/abc/release-remaining-authorization");
  });
});

describe("error mapping", () => {
  it("maps Klarna's error object", async () => {
    const f = mockFetch({ status: 403, json: { error_code: "CAPTURE_NOT_ALLOWED", error_messages: ["Order is cancelled"], correlation_id: "corr-1" } });
    const mcp = await connect(f.fn, { enableWrites: true });
    const r: any = await mcp.callTool({ name: "capture_order", arguments: { order_id: "abc", captured_amount: 100 } });
    expect(r.isError).toBe(true);
    const e = json(r).error;
    expect(e).toMatchObject({
      http_status: 403, error_code: "CAPTURE_NOT_ALLOWED", error_messages: ["Order is cancelled"],
      correlation_id: "corr-1", request: "POST /ordermanagement/v1/orders/abc/captures",
    });
    expect(e.hint).toMatch(/Not allowed/);
  });

  it("maps the v4 error shape and the correlation header", async () => {
    const f = mockFetch({ status: 400, json: { error_id: "e-1", error_code: "VALIDATION_ERROR", error_type: "INPUT_ERROR", error_message: "bad size" } });
    const mcp = await connect(f.fn);
    const r: any = await mcp.callTool({ name: "list_disputes", arguments: {} });
    expect(json(r).error).toMatchObject({ error_code: "VALIDATION_ERROR", error_messages: ["bad size"], correlation_id: "e-1" });

    const g = mockFetch({ status: 500, text: "oops", headers: { "Klarna-Correlation-Id": "hdr-1", "content-type": "text/plain" } });
    const mcp2 = await connect(g.fn);
    const r2: any = await mcp2.callTool({ name: "get_order", arguments: { order_id: "x" } });
    expect(json(r2).error).toMatchObject({ http_status: 500, correlation_id: "hdr-1", error_messages: ["oops"] });
  });

  it("never leaks credentials in errors", async () => {
    const leaky = mockFetch({ status: 401, json: { error_code: "UNAUTHORIZED", error_messages: [`bad header ${AUTH}`, `user ${PASS}`] } });
    const mcp = await connect(leaky.fn);
    const r: any = await mcp.callTool({ name: "get_order", arguments: { order_id: "x" } });
    const t = text(r);
    expect(t).not.toContain(PASS);
    expect(t).not.toContain(AUTH.slice(6));
    expect(t).toContain("[REDACTED]");
    expect(json(r).error.hint).toMatch(/Credentials/);
  });

  it("redacts network errors", async () => {
    const boom: FetchFn = async () => { throw new Error(`socket hang up Authorization: ${AUTH}`); };
    const mcp = await connect(boom);
    const r: any = await mcp.callTool({ name: "get_order", arguments: { order_id: "x" } });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain(AUTH.slice(6));
  });
});
