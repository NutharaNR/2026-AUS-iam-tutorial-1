# Booking Agent

The booking agent is a Python FastAPI service that powers the WayFinder AI
concierge. It accepts chat requests from the Assistant Widget, validates
Asgardeo user tokens, talks to the secured WayFinder MCP server, and uses
Asgardeo's on-behalf-of (OBO) authorization flow when the agent needs explicit
user consent to create bookings.

The service runs locally on `http://localhost:5001` by default.

## Tokens

Three different tokens are involved, and it is worth keeping them apart.

| Token | Client app | Proves | Used for |
| --- | --- | --- | --- |
| User login | SPA (`VITE_ASGARDEO_CLIENT_ID`) | the user, to this service | authenticating `/api/chat`; never forwarded to MCP |
| Agent | MCP client (`ASGARDEO_CLIENT_ID`) | the agent itself | reads: `search_flights`, `get_locations` |
| OBO | MCP client (`ASGARDEO_CLIENT_ID`) | the user, agent as actor | `create_booking` |

The browser sends the user's login token; this service validates it against
`TOKEN_AUDIENCE`, identifies the session, and then obtains its **own** token to
call the MCP server. The user's login token is never passed onward.

The OBO token is issued against the MCP client application, not the SPA — in
that exchange the agent is the OAuth client, the user is the subject, and the
agent is recorded as the actor.

### How a booking gets authorized

1. The user asks to book. The agent calls `create_booking` with its own token.
2. The MCP server rejects it with `insufficient_scope` — the agent has no
   `mcp:create_bookings` scope of its own.
3. The service returns `obo_required`; the widget opens the consent popup.
4. The user approves, and the agent receives an OBO token carrying their
   authority.
5. The booking is retried on the OBO token and succeeds.

Reads continue on the agent's own token throughout, including after consent.

## Asgardeo Configuration

Before running the agent, configure the following items in your Asgardeo
organization.

### 1. Register the frontend SPA

Create or reuse the single-page application used by the frontend.

1. Go to **Applications** > **New Application**.
2. Select **Single-Page Application**.
3. Add the frontend redirect URL used by this sample.
4. Copy the application's **Client ID**.

Use this value in:

```bash
TOKEN_AUDIENCE=<spa-application-client-id>
```

The same client ID should be configured in the frontend as
`VITE_ASGARDEO_CLIENT_ID`.

### 2. Register the booking agent

Create an AI agent identity for this service.

1. Go to **Agents** > **New Agent**.
2. Enter a name such as `WayFinder Booking Agent`.
3. Enable user login for the agent.
4. Select the interactive agent option.
5. Set the callback URL to:

```text
http://localhost:5001/api/obo/callback
```

6. Copy the generated **Agent ID** and **Agent Secret**.

Use these values as follows in .env:

```bash
AGENT_ID=<agent-id>
AGENT_SECRET=<agent-secret>
OBO_REDIRECT_URI=http://localhost:5001/api/obo/callback
```

### 3. Configure the agent OAuth application

The agent authenticates through the OAuth/OIDC application associated with the
agent/MCP client configuration.

Copy its client credentials into:

```bash
ASGARDEO_CLIENT_ID=<agent--application-client-id>
ASGARDEO_CLIENT_SECRET=<agent-or-mcp-client-application-client-secret>
```

Make sure the application allows the callback URL used by this service:

```text
http://localhost:5001/api/obo/callback
```

### 4. Configure scopes and API resource

Create or reuse the API resource that the MCP server's `mcp:*` scopes are
registered on. Three settings must all name that same resource:

| Setting | Where |
| --- | --- |
| `AGENT_RESOURCE` | this service — the agent's own token |
| `OBO_RESOURCE` | this service — the delegated token |
| `ASGARDEO_AUDIENCE` | `mcp/.env` — what the MCP server accepts |

The resource chosen at token-request time decides both which scopes are granted
and the token's audience. If it names a resource Asgardeo does not recognise for
this application, the parameter is **silently ignored**: the token comes back
with the default audience and the `mcp:*` scopes dropped, and the MCP server
rejects it with `invalid_token`.

The default local scopes are:

```bash
AGENT_SCOPES="openid profile mcp:search_flights mcp:get_locations"
OBO_SCOPES="openid profile mcp:create_bookings"
```

These are deliberately disjoint. `AGENT_SCOPES` is what the agent may do alone —
browsing only — and must be granted to the **agent's** role. `OBO_SCOPES` is what
the agent may do on a user's behalf, and must be granted to the **user's** role;
the agent does not need it.

Tools are bound to the least-privileged token that can run them, per call rather
than per request, so searching flights keeps using the agent's own token even
after the user has authorized a booking.

## Local Setup

### 1. Create the environment file

Copy the sample environment file and update the placeholders.

```bash
cp .env.example .env
```

Minimum required values:

```bash
ASGARDEO_BASE_URL=https://api.asgardeo.io/t/<organization-name>
ASGARDEO_CLIENT_ID=<agent-or-mcp-client-app-client-id>
ASGARDEO_CLIENT_SECRET=<agent-or-mcp-client-app-client-secret>
AGENT_ID=<agent-id>
AGENT_SECRET=<agent-secret>
TOKEN_AUDIENCE=<spa-application-client-id>
JWKS_URL=https://api.asgardeo.io/t/<organization-name>/oauth2/jwks
AUTH_ISSUER=https://api.asgardeo.io/t/<organization-name>/oauth2/token
OBO_REDIRECT_URI=http://localhost:5001/api/obo/callback
GOOGLE_API_KEY=<google-ai-studio-api-key>
MODEL_NAME=gemini-3.1-flash-lite
WAYFINDER_MCP_SERVER_URL=http://localhost:8000/mcp
AGENT_SCOPES=openid profile mcp:search_flights mcp:get_locations
OBO_SCOPES=openid profile mcp:create_bookings
AGENT_RESOURCE=<mcp-api-resource-identifier>
OBO_RESOURCE=<mcp-api-resource-identifier>
```

Do not commit `.env` files with real client secrets, agent secrets, or LLM API
keys.

### 2. Install Python dependencies

From the `booking-agent` directory:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Start the required local services

Start the WayFinder MCP server first. The booking agent expects it at:

```text
http://localhost:8000/mcp
```

Start the frontend with:

```bash
VITE_AGENT_API_BASE_URL=http://localhost:5001
```

### 4. Run the booking agent

```bash
python main.py
```

The service starts on:

```text
http://localhost:5001
```

You can override the bind host or port if needed:

```bash
AGENT_SERVER_HOST=127.0.0.1 AGENT_SERVER_PORT=5002 python main.py
```

## API Endpoints

- `POST /api/chat` - sends a user message to the AI booking agent.
- `GET /api/obo/url` - creates the Asgardeo authorization URL for OBO consent.
- `GET /api/obo/callback` - handles the Asgardeo OBO redirect.
- `GET /api/obo/status` - checks whether the current user has an active OBO token.
- `GET /api/obo/pending` - returns the message that triggered authorization.
- `POST /api/logout` - clears the user's in-memory agent session.

All API endpoints except the OBO callback expect:

```http
Authorization: Bearer <asgardeo-access-token>
```

## References

- [Asgardeo AI agent registration](https://wso2.com/asgardeo/docs/guides/agentic-ai/ai-agents/register-and-manage-agents/)
- [Asgardeo agent credentials](https://wso2.com/asgardeo/docs/guides/agentic-ai/ai-agents/agent-credentials/)
- [Asgardeo agent authentication](https://wso2.com/asgardeo/docs/guides/agentic-ai/ai-agents/agent-authentication/)
- [Asgardeo SPA registration](https://wso2.com/asgardeo/docs/guides/applications/register-single-page-app/)
