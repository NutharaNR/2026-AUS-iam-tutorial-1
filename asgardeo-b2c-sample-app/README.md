# Asgardeo B2C Sample App

This repository contains a sample B2C travel booking application secured with Asgardeo. The application demonstrates a travel experience where users can search for flights. Account management in this app is handled by WSO2 Identity Platform Cloud (Asgardeo). The AI agent sample demonstrates how the agent interactions can be made secure using Asgardeo's agentic AI security capabilities.

## Project Structure

```text
asgardeo-b2c-sample-app/
├── frontend/        React + Vite web application
├── api/             Node.js REST API, serving the browser
├── mcp/             TypeScript MCP server, the agents' authorization boundary
├── booking-agent/   Python LangGraph agent with OBO delegation
├── ambient-agent/   TypeScript agent with CIBA approval for offline actions
```

Both the REST API and the MCP server open the same SQLite database. The browser
goes through the REST API; the agents go through the MCP server.

### Quick Setup

Run these in separate terminals, in this order. Seed the database once from
`api/` — the MCP server reads the same file and will not start without it.

API:

```bash
cd api
npm install
npm run seed
npm run dev
```

MCP server:

```bash
cd mcp
npm install
npm run dev
```

Booking agent:

```bash
cd booking-agent
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Ambient agent:

```bash
cd ambient-agent
npm install
npm run dev
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## Components

### Frontend

The `frontend/` app provides the travel booking UI and uses the [Asgardeo React SDK](https://www.npmjs.com/package/@asgardeo/react).

The frontend application

- Renders the flight booking experience
- Integrates with Asgardeo to handle sign in, sign up, and sign out
- Integrates with the Node.js REST API for data persistence

See `frontend/README.md` for setup and local run instructions.

### API

The `api/` app provides REST endpoints used by the frontend.

Features:

- List and search flight information
- Book flights

REST API documentation is available in:

```text
api/openapi.yaml
```

See `api/README.md` for setup, database seeding, and local run instructions.

### MCP Server

The `mcp/` app exposes the travel capabilities as MCP tools for the agents.

Features:

- Expose flight, location, booking, and deal-alert capabilities as MCP tools
- Serve MCP requests over Streamable HTTP at `/mcp`
- Verify the bearer token and enforce a per-tool scope check at the MCP boundary
- Read and write the Wayfinder database in process, so the identity that
  performed an action is the one the token proved

See `mcp/README.md` for setup, tools, scopes, and local run instructions.

### Booking Agent

The `booking-agent/` app is the interactive concierge the user chats with.

Features:

- Reach MCP tools with the agent's own identity using its agent credentials
- Escalate to the user's authority through the on-behalf-of (OBO) flow when a
  tool needs more than the agent holds
- Bind each tool to the least-privileged token that can run it, so browsing
  keeps using the agent's own token even after the user authorizes a booking

See `booking-agent/README.md` for setup, environment variables, and local run instructions.

### Ambient Agent

The `ambient-agent/` app watches for better deals while the user is offline.

Features:

- Scan enabled deal-alert consents with the agent's own identity
- Ask the user to approve a rebooking through CIBA, which pushes a notification
  to their device
- Perform the approved booking, alert transfer, and cancellation through MCP
  with the CIBA token

See `ambient-agent/README.md` for setup, environment variables, and local run instructions.

The API, MCP server, AI agent, and frontend dev commands all watch source files and reload on code changes.

Default local URLs:

```text
Frontend: http://localhost:5173
API:      http://localhost:8787
MCP:      http://localhost:8000/mcp
Agent:    ws://localhost:8790/chat
```
