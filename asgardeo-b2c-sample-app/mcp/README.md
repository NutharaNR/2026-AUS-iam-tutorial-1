# Travel MCP Server

A TypeScript MCP server exposing the Wayfinder Travel capabilities as tools.

Agents connect over Streamable HTTP at `/mcp`. The server authorizes each call
at its own boundary and then reads and writes the Wayfinder database directly,
rather than proxying to the REST API. The REST API continues to serve the
browser and opens the same SQLite file.

```text
agents  ──► MCP server ──► wayfinder.sqlite
browser ──► REST API   ──┘
```

## Tools

Tools read and write the Wayfinder database in process. The REST API still
serves the browser and opens the same SQLite file.

Each tool is gated on a `mcp:`-namespaced scope, verified against the bearer
token at the MCP boundary when `MCP_REQUIRE_AUTH=true`. Tools with no scope
listed still require a valid token, but no particular scope.

| Tool | Required scope |
| --- | --- |
| `search_flights` | `mcp:search_flights` |
| `get_locations` | `mcp:get_locations` |
| `create_booking` | `mcp:create_bookings` |
| `list_deal_alert_consents` | `mcp:deal-alert-consents:read` |
| `cancel_booking` | `mcp:create_bookings` |
| `transfer_deal_alert_consent` | `mcp:deal-alert-consents:write` |
| `search_hotels` | — |
| `get_trips` | — |
| `get_flight_bookings` | — |

`create_booking`, `get_flight_bookings`, `cancel_booking` and
`transfer_deal_alert_consent` derive the acting user from the verified token
alone, never from a tool argument. Cancelling or transferring refuses a booking
owned by anyone else, and does not distinguish "not found" from "not yours".

`list_deal_alert_consents` returns every user's enabled consents so the ambient
agent can match a new flight against all watchers. It is the widest read on the
surface; keep it scoped to the ambient agent.

Recording a deal-alert consent is not an MCP tool: the frontend posts it to the
REST API directly with the signed-in user's own token.

## Local Configuration

Create a local environment file from the example:

```bash
cp .env.example .env
```

Then update the values in `.env` for your local setup.

## Run Locally

Install dependencies:

```bash
cd mcp
npm install
```

Start the MCP server:

```bash
npm run dev
```

The `dev` command watches `server.ts` and restarts the MCP server after code changes. Use `npm start` when you want a non-watching process.

The MCP endpoint is available at:

```text
http://localhost:8000/mcp
```

The health endpoint is available at:

```text
http://localhost:8000/health
```

## Authorization

Set `MCP_REQUIRE_AUTH=true` to enforce authorization at the MCP boundary. Every
tool call then requires a bearer token, which is verified against the identity
provider's JWKS: signature, issuer, audience and expiry. The token is verified
once per session no matter how many tools are called.

Two distinct failures are reported to the caller:

| Result | Meaning |
| --- | --- |
| `invalid_token` | The token failed verification — bad signature, wrong issuer, wrong audience, or expired. |
| `insufficient_scope` | The token is valid but lacks a scope the tool requires. |

Only the code is returned; the reason is deliberately not disclosed, since it
can describe the token.

`ASGARDEO_AUDIENCE` must name the API resource the `mcp:*` scopes are registered
on, and the agents must request that same resource when obtaining their tokens
(`AGENT_RESOURCE` / `OBO_RESOURCE`). The resource chosen at token-request time
decides both which scopes are granted and the token's audience, so a mismatch
surfaces as `invalid_token` rather than `insufficient_scope`.

Unlike the REST API's check, roles and permissions are **not** pooled into the
scope set here: a role name never stands in for a granted scope at this
boundary, and all required scopes must be present, not just one of them.

When `MCP_REQUIRE_AUTH=false` (the default) tools run without authorization.
That is for local demos only — nothing in that mode is an authorization
decision.
