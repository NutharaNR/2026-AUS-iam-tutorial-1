# Travel MCP Server

A simple TypeScript MCP server that wraps the Wayfinder Travel REST API.

The AI agent connects to this server over Streamable HTTP at `/mcp`. The MCP server exposes travel API capabilities as tools, including flight search, bookings, locations, and profile lookup.

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

If a client sends an `Authorization` header to the MCP endpoint, the MCP server forwards that header to the REST API. This allows protected API endpoints to receive the same bearer token provided by the AI agent.
