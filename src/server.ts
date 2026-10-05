// The MCP server factory: Klarna merchant API tools on @modelcontextprotocol/sdk.
// Read tools are always registered. Write tools are registered only when
// writes are enabled (KLARNA_ENABLE_WRITES=true), so a read-only server does
// not even advertise them to the model.
//
// Every endpoint here is taken from Klarna's published API reference:
//   Order Management  https://docs.klarna.com/acquirer/klarna/api/ordermanagement/
//   Settlements       https://docs.klarna.com/acquirer/klarna/api/settlements/
//   Disputes (v4)     https://docs.klarna.com/acquirer/klarna/api/disputes-api-v4/
//   Payments          https://docs.klarna.com/acquirer/klarna/api/payments/

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writesEnabled } from "./config.js";
import { createKlarnaClient, KlarnaApiError, redact, type KlarnaClient } from "./klarna.js";

export const VERSION = "0.1.0";

export const INSTRUCTIONS =
  "Unofficial MCP server for Klarna's merchant APIs (Order Management, Settlements, " +
  "Disputes, Payments sessions). All money amounts are integers in MINOR units of the " +
  "order or payout currency (10000 = 100.00 SEK/EUR/USD). Order ids are Klarna order ids " +
  "(UUIDs), not your shop's order number. Settlements dates are ISO 8601 date-times; use " +
  "full timestamps such as 2026-09-01T00:00:00Z and 2026-09-30T23:59:59Z. Write tools, when " +
  "present, act on real orders: read the order with get_order first, confirm amounts with " +
  "the user, and reuse the returned idempotency_key when retrying.";

const MAX_TEXT = 400_000;

// ---------- shared schemas ----------

const orderId = z.string().min(1).describe("Klarna order id (UUID), as returned at purchase. Not the merchant order number.");
const amountMinor = z.number().int().min(0).max(200_000_000);
const idempotencyKey = z.string().min(1).max(255).optional().describe(
  "Klarna-Idempotency-Key. Omit to have one generated (a UUID). To retry a failed or timed-out " +
  "call safely, pass the idempotency_key returned by the first attempt; Klarna executes a key once " +
  "within 24 hours.",
);

const orderLine = z.object({
  name: z.string().max(255).describe("Descriptive item name"),
  quantity: z.number().int().min(0),
  unit_price: z.number().int().max(200_000_000).describe("Unit price incl. tax, before discounts, in minor units"),
  total_amount: z.number().int().max(200_000_000).describe("quantity * unit_price - total_discount_amount, in minor units"),
  type: z.enum(["physical", "discount", "shipping_fee", "sales_tax", "store_credit", "gift_card", "digital", "surcharge", "return_fee"]).optional(),
  reference: z.string().max(255).optional().describe("SKU or similar"),
  quantity_unit: z.string().max(10).optional(),
  tax_rate: z.number().int().min(0).optional().describe("Percent with two implicit decimals: 2500 = 25%"),
  total_tax_amount: z.number().int().max(200_000_000).optional().describe("Minor units"),
  total_discount_amount: z.number().int().min(0).max(200_000_000).optional().describe("Minor units, incl. tax"),
  merchant_data: z.string().max(1024).optional(),
  product_url: z.string().max(1024).optional(),
  image_url: z.string().max(1024).optional(),
});

const shippingInfo = z.object({
  shipping_company: z.string().max(100).optional().describe("A SHIPPING_COMPANY value from Klarna's carrier list"),
  shipping_method: z.string().optional().describe("e.g. Home, PickUpPoint, PickUpStore, Postal, Own"),
  tracking_number: z.string().max(100).optional(),
  tracking_uri: z.string().max(1024).optional(),
  return_shipping_company: z.string().max(100).optional(),
  return_tracking_number: z.string().max(100).optional(),
  return_tracking_uri: z.string().max(1024).optional(),
});

const settlementDate = (what: string) => z.string().min(10).describe(
  `${what}: ISO 8601 date-time filter on payout date, e.g. 2026-09-01T00:00:00Z. A bare date means 00:00:00 of that day.`,
);
const currencyCode = z.string().regex(/^[A-Z]{3}$/).optional().describe("ISO 4217, e.g. SEK, EUR, USD");
const pageSize = z.number().int().min(1).max(500).optional().describe("1-500, Klarna default 20");
const pageOffset = z.number().int().min(0).optional().describe("Offset for pagination, default 0");

const disputeTimestamp = z.string()
  .regex(/^\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d(:[0-5]\d)?(\.\d{0,3})?Z?$/, "ISO 8601 UTC, e.g. 2026-09-01T00:00:00Z")
  .optional();
const disputeState = z.enum(["INITIATED", "REPRESENTMENT", "PRE_ARBITRATION", "ARBITRATION", "CLOSED"]);
const disputeReason = z.enum([
  "REFUND_NOT_PROCESSED", "PRODUCTS_OR_SERVICES_NOT_RECEIVED", "PRODUCTS_DEFECTIVE_OR_NOT_AS_DESCRIBED",
  "INCORRECT_AMOUNT", "PURCHASE_HIGH_RISK", "PURCHASE_UNAUTHORIZED", "NON_COMPLIANCE", "NON_GUARANTEED_PAYMENT_PROGRAM",
]);

// ---------- helpers ----------

const enc = encodeURIComponent;
const OM = "/ordermanagement/v1/orders";
const SETTLEMENTS = "/settlements/v1";
const DISPUTES = "/v4/payment/disputes";

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function textResult(text: string) {
  const truncated = text.length > MAX_TEXT;
  const out = truncated
    ? text.slice(0, MAX_TEXT) + `\n\n[truncated: ${text.length - MAX_TEXT} more characters. Narrow the date range.]`
    : text;
  return { content: [{ type: "text" as const, text: out }] };
}

function errorResult(e: unknown) {
  if (e instanceof KlarnaApiError) {
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: e.toJSON() }, null, 2) }] };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: redact(msg) }] };
}

async function run<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    return errorResult(e);
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

// ---------- factory ----------

export interface CreateServerOptions {
  client?: KlarnaClient;
  /** Defaults to KLARNA_ENABLE_WRITES === "true". */
  enableWrites?: boolean;
}

export function createKlarnaServer(opts: CreateServerOptions = {}): McpServer {
  const client = opts.client ?? createKlarnaClient();
  const enableWrites = opts.enableWrites ?? writesEnabled();

  const server = new McpServer(
    { name: "klarna", version: VERSION },
    { instructions: INSTRUCTIONS + (enableWrites ? " Write tools are ENABLED." : " This server is read-only.") },
  );

  // ===== Order Management: reads =====

  server.registerTool("get_order", {
    title: "Get order",
    description:
      "Get a Klarna order: status (AUTHORIZED, PART_CAPTURED, CAPTURED, CANCELLED, EXPIRED, CLOSED), " +
      "order_amount, captured_amount, refunded_amount, remaining_authorized_amount, expires_at, " +
      "order lines, captures, refunds, merchant references and addresses. Amounts in minor units. " +
      "This is also where refunds for an order are listed (Klarna has no separate list-refunds endpoint).",
    inputSchema: { order_id: orderId },
    annotations: READ,
  }, async ({ order_id }) => run(async () => {
    const r = await client.request({ method: "GET", path: `${OM}/${enc(order_id)}` });
    return jsonResult(r.body);
  }));

  server.registerTool("list_captures", {
    title: "List captures",
    description: "List all captures on a Klarna order, with captured_amount and refunded_amount (minor units), capture time, references and shipping info.",
    inputSchema: { order_id: orderId },
    annotations: READ,
  }, async ({ order_id }) => run(async () => {
    const r = await client.request({ method: "GET", path: `${OM}/${enc(order_id)}/captures` });
    return jsonResult(r.body);
  }));

  server.registerTool("get_capture", {
    title: "Get capture",
    description: "Get one capture on a Klarna order by capture_id (amounts in minor units).",
    inputSchema: { order_id: orderId, capture_id: z.string().min(1) },
    annotations: READ,
  }, async ({ order_id, capture_id }) => run(async () => {
    const r = await client.request({ method: "GET", path: `${OM}/${enc(order_id)}/captures/${enc(capture_id)}` });
    return jsonResult(r.body);
  }));

  server.registerTool("get_refund", {
    title: "Get refund",
    description: "Get one refund on a Klarna order by refund_id: refunded_amount (minor units), time, description, reference and order lines. To list all refunds, use get_order.",
    inputSchema: { order_id: orderId, refund_id: z.string().min(1) },
    annotations: READ,
  }, async ({ order_id, refund_id }) => run(async () => {
    const r = await client.request({ method: "GET", path: `${OM}/${enc(order_id)}/refunds/${enc(refund_id)}` });
    return jsonResult(r.body);
  }));

  // ===== Settlements =====

  server.registerTool("list_payouts", {
    title: "List payouts",
    description:
      "List Klarna payouts (settlements to your bank account) with totals per payout: sale, fee, " +
      "return, holdback, reversal, tax and settlement amounts, all in minor units. Filter by payout " +
      "date range and currency. Paginated with size/offset; the response has a pagination object with total.",
    inputSchema: {
      start_date: settlementDate("Start").optional(),
      end_date: settlementDate("End").optional(),
      currency_code: currencyCode,
      size: pageSize,
      offset: pageOffset,
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.request({
      method: "GET",
      path: `${SETTLEMENTS}/payouts`,
      query: { start_date: a.start_date, end_date: a.end_date, currency_code: a.currency_code, size: a.size, offset: a.offset },
    });
    return jsonResult(r.body);
  }));

  server.registerTool("get_payout", {
    title: "Get payout",
    description: "Get one Klarna payout by its payment_reference (the reference on your bank statement), with all totals in minor units.",
    inputSchema: { payment_reference: z.string().min(1).describe("Payout reference, as shown on the bank statement or in list_payouts") },
    annotations: READ,
  }, async ({ payment_reference }) => run(async () => {
    const r = await client.request({ method: "GET", path: `${SETTLEMENTS}/payouts/${enc(payment_reference)}` });
    return jsonResult(r.body);
  }));

  server.registerTool("get_payout_summary", {
    title: "Payout summary",
    description:
      "Summary of all payouts in a date range, one entry per currency: total sales, fees, returns, " +
      "commissions, holdback, releases, reversals, tax and settlement amount (minor units). Good for monthly reconciliation.",
    inputSchema: {
      start_date: settlementDate("Start"),
      end_date: settlementDate("End (use 23:59:59 to include the whole day)"),
      currency_code: currencyCode,
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.request({
      method: "GET",
      path: `${SETTLEMENTS}/payouts/summary`,
      query: { start_date: a.start_date, end_date: a.end_date, currency_code: a.currency_code },
    });
    return jsonResult(r.body);
  }));

  server.registerTool("list_transactions", {
    title: "List settlement transactions",
    description:
      "List settlement transactions (SALE, RETURN, FEE, REVERSAL and so on) with amount in minor units, " +
      "order id, capture/refund ids, merchant references and payout reference. Filter by payout " +
      "(payment_reference) and/or Klarna order_id. Klarna's API has no date filter here: to get a period, " +
      "find the payouts with list_payouts and pass each payment_reference. Paginated with size/offset.",
    inputSchema: {
      payment_reference: z.string().min(1).optional().describe("Payout reference to filter by"),
      order_id: z.string().min(1).optional().describe("Klarna order id to filter by"),
      size: pageSize,
      offset: pageOffset,
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.request({
      method: "GET",
      path: `${SETTLEMENTS}/transactions`,
      query: { payment_reference: a.payment_reference, order_id: a.order_id, size: a.size, offset: a.offset },
    });
    return jsonResult(r.body);
  }));

  server.registerTool("get_payout_report_csv", {
    title: "Payout report (CSV)",
    description:
      "Download the settlement report for one payout, with all its transactions, as CSV text " +
      "(Klarna's documented settlement report format). Use for reconciliation in a spreadsheet.",
    inputSchema: { payment_reference: z.string().min(1) },
    annotations: READ,
  }, async ({ payment_reference }) => run(async () => {
    const r = await client.request({
      method: "GET",
      path: `${SETTLEMENTS}/reports/payout-with-transactions`,
      query: { payment_reference },
      accept: "text/csv",
    });
    return textResult(String(r.body ?? ""));
  }));

  server.registerTool("get_payouts_summary_report_csv", {
    title: "Payouts summary report (CSV)",
    description: "Download a CSV report of all payouts and their transactions between two dates. Can be large: keep the range short (a month or less).",
    inputSchema: {
      start_date: settlementDate("Start"),
      end_date: settlementDate("End"),
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.request({
      method: "GET",
      path: `${SETTLEMENTS}/reports/payouts-summary-with-transactions`,
      query: { start_date: a.start_date, end_date: a.end_date },
      accept: "text/csv",
    });
    return textResult(String(r.body ?? ""));
  }));

  // ===== Disputes (v4) =====

  server.registerTool("list_disputes", {
    title: "List disputes",
    description:
      "List customer disputes (Klarna Disputes API v4) filtered by order, state, reason, purchase " +
      "reference and date ranges. States: INITIATED, REPRESENTMENT, PRE_ARBITRATION, ARBITRATION, CLOSED. " +
      "Cursor pagination: pass pagination.last_item from the previous page as starting_after. " +
      "Your merchant account must be enrolled for the Disputes API; an empty list can also mean it is not.",
    inputSchema: {
      order_ids: z.array(z.string().min(1)).max(100).optional(),
      payment_transaction_ids: z.array(z.string().min(1)).max(100).optional(),
      merchant_ids: z.array(z.string().min(1)).max(100).optional(),
      state: z.array(disputeState).max(100).optional(),
      reason: z.array(disputeReason).max(10).optional(),
      purchase_references: z.array(z.string().min(1).max(255)).max(10).optional().describe("Your customer-facing order numbers"),
      sort_by: z.array(z.enum(["created_at", "-created_at", "closed_at", "-closed_at"])).max(10).optional()
        .describe("Prefix with - for descending. Klarna default: created_at"),
      created_at_start: disputeTimestamp.describe("Disputes created at or after, ISO 8601 UTC"),
      created_at_end: disputeTimestamp.describe("Disputes created before, ISO 8601 UTC"),
      closed_at_start: disputeTimestamp,
      closed_at_end: disputeTimestamp,
      updated_at_start: disputeTimestamp,
      updated_at_end: disputeTimestamp,
      size: z.number().int().min(1).optional().describe("Page size; omit for Klarna's default"),
      starting_after: z.string().min(1).optional().describe("Cursor: pagination.last_item from the previous page"),
    },
    annotations: READ,
  }, async (a) => run(async () => {
    const r = await client.request({ method: "GET", path: DISPUTES, query: { ...a } });
    return jsonResult(r.body);
  }));

  server.registerTool("get_dispute", {
    title: "Get dispute",
    description: "Get one dispute in its current state, including its requests, deadlines and evidence history (Klarna Disputes API v4).",
    inputSchema: { payment_dispute_id: z.string().min(1).max(100) },
    annotations: READ,
  }, async ({ payment_dispute_id }) => run(async () => {
    const r = await client.request({ method: "GET", path: `${DISPUTES}/${enc(payment_dispute_id)}` });
    return jsonResult(r.body);
  }));

  // ===== Payments (read only) =====

  server.registerTool("get_payment_session", {
    title: "Get payment session",
    description:
      "Read a Klarna Payments session by session_id: status, order amount and lines (minor units), " +
      "purchase country/currency, payment method categories and expiry. Useful when debugging a checkout " +
      "that never became an order. This server never creates or updates sessions.",
    inputSchema: { session_id: z.string().min(1) },
    annotations: READ,
  }, async ({ session_id }) => run(async () => {
    const r = await client.request({ method: "GET", path: `/payments/v1/sessions/${enc(session_id)}` });
    return jsonResult(r.body);
  }));

  if (enableWrites) registerWriteTools(server, client);
  return server;
}

// ===== Order Management: writes (only with KLARNA_ENABLE_WRITES=true) =====

function registerWriteTools(server: McpServer, client: KlarnaClient) {
  const env = () => {
    try { const d = client.describe(); return { environment: d.env, region: d.region }; } catch { return {}; }
  };

  server.registerTool("capture_order", {
    title: "Capture order",
    description:
      "WRITE. Capture (charge) all or part of an authorized Klarna order. captured_amount is in minor units " +
      "(10000 = 100.00). For a full capture, pass the order's remaining_authorized_amount from get_order; " +
      "for a partial capture, pass less (and ideally the shipped order_lines). In production this charges " +
      "the customer. Confirm the order id and amount with the user before calling. Returns capture_id and the " +
      "idempotency_key to reuse on retry.",
    inputSchema: {
      order_id: orderId,
      captured_amount: amountMinor.describe("Amount to capture, minor units"),
      description: z.string().max(255).optional().describe("Shown to the customer"),
      reference: z.string().max(255).optional().describe("Your internal capture reference; appears in settlement files"),
      order_lines: z.array(orderLine).max(1000).optional().describe("Lines included in this capture"),
      shipping_info: z.array(shippingInfo).max(500).optional(),
      shipping_delay: z.number().int().min(0).optional().describe("Delay before shipping"),
      idempotency_key: idempotencyKey,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (a) => run(async () => {
    const key = a.idempotency_key ?? randomUUID();
    const { order_id, idempotency_key: _k, ...body } = a;
    const r = await client.request({ method: "POST", path: `${OM}/${enc(order_id)}/captures`, body, idempotencyKey: key });
    return jsonResult({
      ...env(), order_id, idempotency_key: key, http_status: r.status,
      capture_id: r.headers["capture-id"] ?? null, location: r.headers["location"] ?? null,
      captured_amount: a.captured_amount,
    });
  }));

  server.registerTool("refund_order", {
    title: "Refund order",
    description:
      "WRITE. Refund all or part of a captured Klarna order. refunded_amount is in minor units and cannot exceed " +
      "the captured, not yet refunded amount. In production this returns money to the customer and cannot be " +
      "undone. Confirm with the user first. Returns refund_id and the idempotency_key to reuse on retry.",
    inputSchema: {
      order_id: orderId,
      refunded_amount: amountMinor.describe("Amount to refund, minor units"),
      description: z.string().max(255).optional().describe("Shown to the customer"),
      reference: z.string().max(255).optional().describe("Your internal refund reference; appears in settlement files"),
      order_lines: z.array(orderLine).max(1000).optional().describe("Refunded lines (optional, improves the customer's view)"),
      idempotency_key: idempotencyKey,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (a) => run(async () => {
    const key = a.idempotency_key ?? randomUUID();
    const { order_id, idempotency_key: _k, ...body } = a;
    const r = await client.request({ method: "POST", path: `${OM}/${enc(order_id)}/refunds`, body, idempotencyKey: key });
    return jsonResult({
      ...env(), order_id, idempotency_key: key, http_status: r.status,
      refund_id: r.headers["refund-id"] ?? null, location: r.headers["location"] ?? null,
      refunded_amount: a.refunded_amount,
    });
  }));

  server.registerTool("extend_authorization_time", {
    title: "Extend authorization time",
    description:
      "WRITE. Extend the time an authorized Klarna order can be captured (moves expires_at). For unexpected " +
      "fulfilment delays. Klarna returns 403 if the order is expired or cancelled. Check the new expires_at with get_order.",
    inputSchema: { order_id: orderId, idempotency_key: idempotencyKey },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ order_id, idempotency_key }) => run(async () => {
    const key = idempotency_key ?? randomUUID();
    const r = await client.request({ method: "POST", path: `${OM}/${enc(order_id)}/extend-authorization-time`, idempotencyKey: key });
    return jsonResult({ ...env(), order_id, idempotency_key: key, http_status: r.status, result: "authorization time extended" });
  }));

  server.registerTool("cancel_order", {
    title: "Cancel order",
    description:
      "WRITE, irreversible. Cancel an authorized Klarna order that has no captures. The customer will not be " +
      "charged and the order cannot be captured afterwards. If the order is partly captured, use " +
      "release_remaining_authorization instead. Confirm with the user first.",
    inputSchema: { order_id: orderId, idempotency_key: idempotencyKey },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ order_id, idempotency_key }) => run(async () => {
    const key = idempotency_key ?? randomUUID();
    const r = await client.request({ method: "POST", path: `${OM}/${enc(order_id)}/cancel`, idempotencyKey: key });
    return jsonResult({ ...env(), order_id, idempotency_key: key, http_status: r.status, result: "order cancelled" });
  }));

  server.registerTool("release_remaining_authorization", {
    title: "Release remaining authorization",
    description:
      "WRITE, irreversible. On a partly captured Klarna order, release the remaining authorized amount so it " +
      "can no longer be captured. Klarna returns 403 if the order is cancelled or " +
      "has no captures. Confirm with the user first.",
    inputSchema: { order_id: orderId, idempotency_key: idempotencyKey },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ order_id, idempotency_key }) => run(async () => {
    const key = idempotency_key ?? randomUUID();
    const r = await client.request({ method: "POST", path: `${OM}/${enc(order_id)}/release-remaining-authorization`, idempotencyKey: key });
    return jsonResult({ ...env(), order_id, idempotency_key: key, http_status: r.status, result: "remaining authorization released" });
  }));
}
