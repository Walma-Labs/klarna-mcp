# klarna-mcp: an MCP server for Klarna's merchant APIs

A small [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude, Cursor, Claude Code and any other MCP client access to Klarna's merchant APIs: orders, captures, refunds, payouts, settlement transactions, disputes and payment sessions.

It is **read-only by default**. Write tools (capture, refund, extend authorization, cancel, release) exist, but they are not even registered unless you set `KLARNA_ENABLE_WRITES=true`.

Built by [Walma AI](https://walma.ai). There is a longer write-up in our guide: [Klarna MCP](https://walma.ai/en/guides/mcp/klarna-mcp). For how e-commerce teams use servers like this one, see [AI for e-commerce](https://walma.ai/en/ai-for-ecommerce).

> **Unofficial.** This project is not made, endorsed or supported by Klarna, and is not affiliated with Klarna Bank AB. "Klarna" is a trademark of Klarna Bank AB, used here only to describe which API the server talks to.

> **Status:** built against Klarna's documented API; not yet verified against a live Klarna environment. Try it on the playground first and please report anything that does not match.

## Tools

All money amounts, in and out, are integers in **minor units** of the currency: `10000` means 100.00 SEK, EUR or USD.

**Read tools (always available)**

| Tool | Klarna endpoint | What it does |
|---|---|---|
| `get_order` | `GET /ordermanagement/v1/orders/{order_id}` | Order status, amounts (authorized, captured, refunded, remaining), expiry, lines, captures and refunds |
| `list_captures` | `GET /ordermanagement/v1/orders/{order_id}/captures` | All captures on an order |
| `get_capture` | `GET /ordermanagement/v1/orders/{order_id}/captures/{capture_id}` | One capture |
| `get_refund` | `GET /ordermanagement/v1/orders/{order_id}/refunds/{refund_id}` | One refund (all refunds are listed on the order) |
| `list_payouts` | `GET /settlements/v1/payouts` | Payouts with totals, by date range and currency, paginated |
| `get_payout` | `GET /settlements/v1/payouts/{payment_reference}` | One payout by the reference on your bank statement |
| `get_payout_summary` | `GET /settlements/v1/payouts/summary` | Totals per currency for a date range |
| `list_transactions` | `GET /settlements/v1/transactions` | Settlement transactions by payout and/or order, paginated |
| `get_payout_report_csv` | `GET /settlements/v1/reports/payout-with-transactions` | One payout with its transactions, as CSV text |
| `get_payouts_summary_report_csv` | `GET /settlements/v1/reports/payouts-summary-with-transactions` | All payouts and transactions in a date range, as CSV text |
| `list_disputes` | `GET /v4/payment/disputes` | Disputes by order, state, reason, reference and dates, cursor-paginated |
| `get_dispute` | `GET /v4/payment/disputes/{payment_dispute_id}` | One dispute with its requests and deadlines |
| `get_payment_session` | `GET /payments/v1/sessions/{session_id}` | A Klarna Payments session (never creates or updates one) |

**Write tools (only with `KLARNA_ENABLE_WRITES=true`)**

| Tool | Klarna endpoint | Annotation |
|---|---|---|
| `capture_order` | `POST /ordermanagement/v1/orders/{order_id}/captures` | destructive |
| `refund_order` | `POST /ordermanagement/v1/orders/{order_id}/refunds` | destructive |
| `extend_authorization_time` | `POST /ordermanagement/v1/orders/{order_id}/extend-authorization-time` | not destructive |
| `cancel_order` | `POST /ordermanagement/v1/orders/{order_id}/cancel` | destructive |
| `release_remaining_authorization` | `POST /ordermanagement/v1/orders/{order_id}/release-remaining-authorization` | destructive |

Read tools carry `readOnlyHint: true`. Write tools carry `readOnlyHint: false`, and every write that moves money or cannot be undone carries `destructiveHint: true`, so clients that honour annotations ask before running them. Capture is marked destructive too: it is an additive call in API terms, but it charges a customer.

## Safety model

1. **Read-only unless you say otherwise.** Without `KLARNA_ENABLE_WRITES=true` (exactly `true`) the write tools do not exist on the server, so the model cannot call them, whatever the prompt says.
2. **Playground first.** `KLARNA_ENV` defaults to `playground`. Point it at `production` only after you have watched the tools behave on test orders.
3. **Idempotency on every write.** Each write sends a `Klarna-Idempotency-Key` header. The tool generates one if you do not pass it and returns it in the result; retry a failed or timed-out write with the same `idempotency_key` and Klarna executes it at most once (Klarna keeps keys for 24 hours).
4. **Credentials stay out of the conversation.** They are read from the environment and sent only in the `Authorization` header. Error messages are built from Klarna's `error_code`, `error_messages` and `correlation_id`, and anything that looks like a credential is redacted before it reaches the model.
5. **Use a dedicated credential.** Create a separate API credential for the agent in the Klarna Merchant Portal so you can revoke it on its own.

## Setup

### 1. Get API credentials

In the Klarna Merchant Portal, create an API credential for the environment you want. Klarna's keys say which one they belong to: `klarna_test_api_...` is for the playground, `klarna_live_api_...` for production. When you create the credential, Klarna shows a username (a UUID) next to the API key; use the username as `KLARNA_USERNAME` and the API key as `KLARNA_PASSWORD`, or set only `KLARNA_API_KEY`.

### 2. Install

The package is not on npm. Clone and build it:

```bash
git clone https://github.com/Walma-Labs/klarna-mcp.git
cd klarna-mcp
npm install
npm run build
```

This gives you `dist/stdio.js`. Node 20 or newer is required.

### 3. Configure

| Variable | Default | Meaning |
|---|---|---|
| `KLARNA_USERNAME` | | API credential username |
| `KLARNA_PASSWORD` | | API credential password (the API key or shared secret) |
| `KLARNA_API_KEY` | | Alternative to the two above: a `klarna_<live\|test>_api_...` key, sent as `Authorization: Basic <API key>` as Klarna documents it |
| `KLARNA_REGION` | `eu` | `eu`, `na` or `oc` |
| `KLARNA_ENV` | `playground` | `playground` or `production` |
| `KLARNA_ENABLE_WRITES` | off | `true` registers the write tools |

Region and environment map to Klarna's documented hosts:

| | Production | Playground |
|---|---|---|
| `eu` | `https://api.klarna.com` | `https://api.playground.klarna.com` |
| `na` | `https://api-na.klarna.com` | `https://api-na.playground.klarna.com` |
| `oc` | `https://api-oc.klarna.com` | `https://api-oc.playground.klarna.com` |

### 4. Add it to your client

Use the absolute path to your clone.

**Claude Code**

```bash
claude mcp add --transport stdio klarna \
  -e KLARNA_USERNAME=your-username \
  -e KLARNA_PASSWORD=your-password \
  -e KLARNA_REGION=eu \
  -e KLARNA_ENV=playground \
  -- node /absolute/path/to/klarna-mcp/dist/stdio.js
```

Add `-e KLARNA_ENABLE_WRITES=true` only when you want the write tools.

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "klarna": {
      "command": "node",
      "args": ["/Users/you/klarna-mcp/dist/stdio.js"],
      "env": {
        "KLARNA_USERNAME": "your-username",
        "KLARNA_PASSWORD": "your-password",
        "KLARNA_REGION": "eu",
        "KLARNA_ENV": "playground"
      }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "klarna": {
      "command": "node",
      "args": ["/Users/you/klarna-mcp/dist/stdio.js"],
      "env": {
        "KLARNA_USERNAME": "your-username",
        "KLARNA_PASSWORD": "your-password",
        "KLARNA_REGION": "eu",
        "KLARNA_ENV": "playground"
      }
    }
  }
}
```

Desktop clients do not expand `~` or inherit your shell's `PATH`, so use absolute paths (and the absolute path to `node` if it is not found).

### Running it as a remote server

`dist/http.js` is a stateless [streamable-HTTP](https://modelcontextprotocol.io/docs/concepts/transports) entrypoint for hosting the server centrally. It listens on `PORT` (default 8080) with a `/healthz` endpoint and has **no auth of its own**: anyone who reaches the port uses your Klarna credentials. Only run it behind a gateway that authenticates callers. Programmatic hosts can `import { createKlarnaServer } from "klarna-mcp"` and mount it on any transport.

## Using it

Example prompts for an e-commerce or finance team:

- "Show me order `<klarna order id>`: what is authorized, what is captured, and when does the authorization expire?"
- "Sum up our Klarna payouts for September per currency: sales, fees, returns and what actually hit the bank."
- "Get payout `<payment reference>` and list its transactions. Which fees and returns are in it?"
- "Which settlement transactions belong to order `<klarna order id>`, and in which payout did the sale land?"
- "List open disputes created in the last 30 days, grouped by reason, and tell me which deadlines are closest."
- "Download the payout report CSV for `<payment reference>` and reconcile it against this export from our shop."
- With writes on, on the playground: "Capture 450.00 SEK of order `<id>` for the two lines that shipped today, with DHL tracking number 123."

Things to tell the agent:

- **Order ids are Klarna's order ids**, not your shop's order number. Your number is `merchant_reference1` on the order.
- **Settlements dates are date-times.** A bare date means midnight, so ask for `2026-09-30T23:59:59Z` to include the last day.
- **Transactions have no date filter** in Klarna's API. Find the payouts for a period first, then list transactions per payout.
- **Disputes need enrollment.** Klarna's Disputes API v4 requires your merchant account to be enrolled; an empty list can mean you are not. Klarna's v4 reference lists only the EU hosts.

## Development

```bash
npm install
npm run build && npm test
KLARNA_USERNAME=... KLARNA_PASSWORD=... node dist/stdio.js
```

Tests drive the real MCP wire and the real HTTP client against a mocked `fetch`, so they need no network or credentials. Try the server interactively with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/stdio.js
```

### Sources

Every endpoint, field and header comes from Klarna's published API reference:

- [Order Management API](https://docs.klarna.com/acquirer/klarna/api/ordermanagement/)
- [Settlements API](https://docs.klarna.com/acquirer/klarna/api/settlements/)
- [Disputes API v4](https://docs.klarna.com/acquirer/klarna/api/disputes-api-v4/)
- [Payments API](https://docs.klarna.com/acquirer/klarna/api/payments/)
- [API URLs](https://docs.klarna.com/acquirer/klarna/get-started/integration-resilience/api-urls/), [Authentication](https://docs.klarna.com/acquirer/klarna/get-started/integration-resilience/authentication/), [Errors](https://docs.klarna.com/acquirer/klarna/get-started/integration-resilience/errors/), [Escalation and retry policy](https://docs.klarna.com/acquirer/klarna/get-started/integration-resilience/escalation-and-retry-policy/)

Left out on purpose: the PDF settlement reports (binary), order updates (amount, lines, addresses, references, shipping info), due-date extensions and customer send-outs, dispute responses and evidence uploads, and creating payment sessions or orders.

## License

MIT. Copyright (c) 2026 Walma AI AB.
