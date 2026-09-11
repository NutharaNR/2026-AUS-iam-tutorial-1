# Ambient Agent

This folder contains the Wayfinder ambient agent that demonstrates Asgardeo agent authentication.

The agent authenticates with Asgardeo using agent credentials, receives an agent access token, and uses that token to call a protected MCP server. It exposes one business webhook endpoint that is triggered whenever a new flight is added to the Wayfinder database.

## What It Demonstrates

- Authenticating an AI agent with Asgardeo
- Requesting an agent token through `@asgardeo/javascript`
- Passing the agent token to an MCP server as a bearer token
- Loading MCP tools with `@langchain/mcp-adapters`
- Receiving new-flight events through a webhook
- Comparing new flights against existing better-deal alert consents
- Using a LangGraph ReAct agent to write smart CIBA approval messages
- Starting CIBA approval flows for relevant users through a native LangChain tool in the ambient agent

## Local Configuration

Install dependencies:

```bash
cd ambient-agent
npm install
```

Create a local environment file from the example:

```bash
cp .env.example .env
```

Then update the values in `.env` for your local setup.

## Run Locally

Start your MCP server first, then run the AI agent:

```bash
cd ambient-agent
npm run dev
```

The dev command watches `agent.ts` and restarts the agent after code changes. Use `npm start` when you want a non-watching process.

The new-flight webhook endpoint is available at:

```text
http://localhost:8790/deal-alerts
```

The health endpoint is available at:

```text
http://localhost:8790/health
```

## Better-Deal Alert Flow

After a flight booking, the B2C frontend stores offline better-deal alert consent through `POST /api/deal-alert-consents`.

When the API receives a new flight through `POST /api/flights`, it calls the ambient agent's `POST /deal-alerts` webhook with the new flight details. The agent fetches enabled deal-alert consent candidates from MCP, compares the new flight against their saved route and criteria, asks a LangGraph ReAct agent to write user-friendly CIBA binding messages, and invokes its native `process_new_flight_deal_alerts` LangChain tool for the relevant users. The first user who approves gets the new flight booked and their previous booking canceled; the remaining pending polls are canceled.

## Webhook Payload

Send a JSON payload with a `flight` object:

```json
{
  "flight": {
    "id": "flight-colombo-singapore-new",
    "from": "Colombo",
    "to": "Singapore",
    "airline": "WSO2 Air",
    "departureTime": "08:30",
    "arrivalTime": "14:30",
    "duration": "4h 30m",
    "stops": 0,
    "price": 320,
    "currency": "USD",
    "cabin": "Economy",
    "dates": "May 27"
  }
}
```

The server accepts the event immediately:

```json
{
  "status": "accepted",
  "flightId": "flight-colombo-singapore-new"
}
```

## Two Levels of Authority

The agent carries two deliberately unequal kinds of authority.

**Its own**, obtained from its agent credentials with `AGENT_SCOPES`, covers
only looking: reading the watch list via `list_deal_alert_consents`, which needs
`mcp:deal-alert-consents:read`. Nothing it can do alone changes anything or
costs anyone money. `AGENT_RESOURCE` must name the API resource the `mcp:*`
scopes are registered on, or the token is issued for the wrong audience and the
MCP server rejects it with `invalid_token`.

**Borrowed**, obtained per user per action through CIBA, covers acting: booking
the better flight, moving the alert, and cancelling the old booking. It does not
exist until that user approves on their device, and is gone afterwards.

This split matters because the agent runs unsupervised. If booking were part of
its standing permissions, any failure — a bug in the matching logic, a bad price
— could spend real money across every watcher at once.

### Post-approval actions

All three writes go through the MCP server with the CIBA token, so each passes
the same authorization boundary as the reads, and the booking owner is taken
from the verified token rather than from a request header:

| Action | Tool | Scope |
| --- | --- | --- |
| Book the better flight | `create_booking` | `mcp:create_bookings` |
| Move the alert to it | `transfer_deal_alert_consent` | `mcp:deal-alert-consents:write` |
| Cancel the old booking | `cancel_booking` | `mcp:create_bookings` |

`CIBA_SCOPE` must therefore carry `mcp:create_bookings` and
`mcp:deal-alert-consents:write`, granted to the **user's** role — not the
agent's.

The native CIBA tool uses `CLIENT_ID` and `CLIENT_SECRET` for Asgardeo CIBA endpoint authorization, and passes the ambient agent access token as `actor_token` in the CIBA authorization request. Configure `ASGARDEO_BASE_URL`, `CIBA_SCOPE`, `CIBA_NOTIFICATION_CHANNEL`, `CIBA_POLL_INTERVAL_SECONDS`, and `CIBA_POLL_TIMEOUT_MS` in the ambient agent environment as needed. Set `CIBA_LOG_AUTH_URL=true` only for local debugging when you need to inspect an `auth_url` returned by Asgardeo.

## Notes

- The MCP server must accept `Authorization: Bearer <agent-access-token>`, and
  its `ASGARDEO_AUDIENCE` must match the resource the agent requests.
- The `POST /deal-alerts` webhook is unauthenticated: it is an internal callback
  from the REST API and should not be exposed publicly.
- The sample is intended for local demos and development. Do not commit real agent secrets, API keys, or local `.env` files.
