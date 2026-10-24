# heydenta-mcp

An MCP server that lets any MCP client (Claude Desktop, Claude Code, Cursor, an agent loop) book appointments at a HeyDenta clinic through four tools. Written in TypeScript on Node 22 with the official `@modelcontextprotocol/server` SDK, stdio transport.

## What it does, in one breath

A model asks "is the clinic open Friday, what is free, book 10:30 for Juan". The MCP client turns each step into a tool call. This server turns each tool call into a HeyDenta API request, with the clinic's key, retries and an idempotency guard, and hands the answer back as text the model can read plus structured JSON the client can use.

## The four tools

| Tool | When the model uses it | Backend call |
|---|---|---|
| `get_clinic_hours` | "are you open", hours, which dentists | `GET /api/intake/availability` (public, no PII) |
| `list_open_slots` | free times on a date | same endpoint, the `free` list |
| `find_next_open_slot` | "soonest", no date given | the same call day by day, up to 14 days |
| `create_booking` | name, mobile, date and a free time are in hand | `POST /api/aria-tool/create-booking` with the clinic's bearer key |

Read-only tools carry `readOnlyHint`. `create_booking` carries `idempotentHint` and a required `idempotency_key`.

## Where the hard parts live

1. **Tool schemas and descriptions a model uses correctly**: `src/tools.ts`. Every description says when to use the tool, what it returns and what to do next. Every argument has a format and an example. Dates are `YYYY-MM-DD`, times `HH:MM` 24 hour, both clinic local (Asia/Manila).
2. **Auth, retries, rate limits, idempotency behind the tools**: `src/api.ts`. The key goes in the `Authorization` header, never in a URL. Network errors, 429 and 5xx retry three times with exponential backoff; any other 4xx returns at once because a retry cannot fix a bad request. `create_booking` reuses the model's `idempotency_key` as the server-side customer id, and `src/idempotency.ts` keeps a local file of key to booking, so a retried call never posts twice.
3. **Debuggable in production**: tool failures come back as `isError` with a sentence the model can act on (suggested slots on a clash, "try again in a minute" on an outage). Startup and failures log to stderr; stdout is the protocol channel and stays clean.

## Run it

```sh
npm install
npm run build
HEYDENTA_API_KEY=hd_aria_... HEYDENTA_CLINIC_ID=1 HEYDENTA_CLINIC_SLUG=your-clinic-slug node dist/index.js
```

Claude Desktop or Claude Code config:

```json
{
  "mcpServers": {
    "heydenta": {
      "command": "node",
      "args": ["/path/to/heydenta-mcp/dist/index.js"],
      "env": { "HEYDENTA_API_KEY": "hd_aria_...", "HEYDENTA_CLINIC_ID": "1", "HEYDENTA_CLINIC_SLUG": "your-clinic-slug" }
    }
  }
}
```

Optional: `HEYDENTA_BASE_URL` (default `https://app.heydenta.com`), `HEYDENTA_MCP_STATE` (idempotency file, default `~/.heydenta-mcp/bookings.json`).

## Cloud runtime: HTTP entry and container

`src/http.ts` serves the same four tools over Streamable HTTP (stateless, JSON responses) at `POST /mcp`, gated by a bearer in `MCP_AUTH_TOKEN`, with `GET /healthz` open for probes. The `Dockerfile` builds a Node 22 image with the AWS Lambda Web Adapter copied in, so the one image runs as a Lambda container (function URL in front, CloudWatch logs) or anywhere with `docker run -p 8080:8080`. On Lambda the idempotency file lives in `/tmp`, so it protects one warm instance; the server-side guard (same patient, same slot) is the durable layer.

```sh
docker build -t heydenta-mcp .
docker run --rm -p 8080:8080 -e MCP_AUTH_TOKEN=... -e HEYDENTA_API_KEY=... -e HEYDENTA_CLINIC_ID=1 -e HEYDENTA_CLINIC_SLUG=... heydenta-mcp
```

MCP client config for the remote server: type `http`, url `https://<endpoint>/mcp`, header `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Deployed 2026-10-21 to AWS Lambda (ap-southeast-2) from the image in ECR, with an API Gateway HTTP API in front. Two things learned on the way: Lambda rejects an image pushed with Docker's default provenance and SBOM attestation manifests (build with `--provenance=false --sbom=false`), and in the new AWS account experience a Lambda function URL with public auth answers 403 before the code runs, while API Gateway invoking the function as a service principal passes. Logs are in CloudWatch under `/aws/lambda/heydenta-mcp`.

## Tests

```sh
npm test
```

Ten tests. Four unit tests on the API client with a fake `fetch`: retry on 5xx, no retry on 4xx, give up after three network errors, bearer in the header and never in the URL. Two on the slot label and date helpers. Two end to end tests that spawn the real server over stdio against a local fake HeyDenta: `tools/list` shows the four tools, then hours, slots, next slot, a booking, the same booking again (one POST reaches the API), a taken slot (error with suggestions) and a malformed time (rejected before any API call). Two on the HTTP entry: the bearer gate and a real Streamable HTTP client round trip.

## Eval

```sh
OPENROUTER_API_KEY=... npm run eval            # pass rate against the stored baseline, exit 1 on regression
OPENROUTER_API_KEY=... npm run eval -- --baseline
```

`evals/golden.json` holds 20 receptionist requests with the tool and arguments a model should pick. `evals/run.mjs` reads the live `tools/list`, asks a model through OpenRouter with tool calling, and compares. Nothing is executed against HeyDenta. The first run exposed two description faults; after the fix gpt-5.4-mini scores 14 of 20 (`evals/baseline.json`, `evals/last-run.json`).

## Layout

```
src/index.ts        start: config from env, stdio transport
src/api.ts          HeyDenta client: auth header, retries with backoff, typed results
src/idempotency.ts  local key to booking store (memory for tests, file for real)
src/tools.ts        the four registerTool calls
test/api.test.ts    client behaviour with a fake fetch
test/e2e.test.ts    real client, real server, fake HeyDenta over http
```

## Why no `get_booking_status` tool

HeyDenta has no bearer-authed read for a single appointment today; reads go through a signed-in staff session. Adding one is a change in the HeyDenta repo, not in this server, so the fourth tool is `find_next_open_slot`, which the booking flow needs anyway.
