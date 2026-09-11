/*
Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com). All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
    AuthError,
    requireScope,
    scopesForTool,
    verifyClaims,
    type VerifiedClaims,
} from "./auth.js";
import {
    cancelBooking,
    createBooking,
    DataError,
    initializeData,
    listAllDealAlertConsents,
    listFlightBookings,
    listLocations,
    listTrips,
    searchFlights,
    searchHotels,
    transferDealAlertConsent,
} from "./data.js";
import { getDurationMs, getStartTime, logger, logToolOperation, type Logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath: string) {
    if (!existsSync(filePath)) {
        return;
    }

    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (!trimmedLine || trimmedLine.startsWith("#")) {
            continue;
        }

        const separatorIndex = trimmedLine.indexOf("=");

        if (separatorIndex <= 0) {
            continue;
        }

        const key = trimmedLine.slice(0, separatorIndex).trim();
        const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
        const value = rawValue.replace(/^\s*["']|["']\s*$/g, "");

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

loadEnvFile(resolve(__dirname, ".env"));

const port = Number(process.env.PORT || process.env.MCP_PORT || 8000);
const host = process.env.HOST || "localhost";
const requireAuth = process.env.MCP_REQUIRE_AUTH === "true";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function decodeBase64UrlJson(value: string) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");

    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
}

function getBearerTokenClaims(authorization: string | undefined) {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const parts = token.split(".");

    if (parts.length !== 3) {
        return null;
    }

    try {
        const payload = decodeBase64UrlJson(parts[1]);

        return {
            audience: payload.aud,
            issuer: payload.iss,
            permissions: payload.permissions,
            roles: payload.roles,
            scope: payload.scope,
            scp: payload.scp,
            subject: payload.sub,
        };
    } catch {
        return null;
    }
}

function getAuthorizationHeader(request: IncomingMessage): string | undefined {
    const authorization = request.headers.authorization;

    return Array.isArray(authorization) ? authorization[0] : authorization;
}

/**
 * Verify the session's bearer token at most once, no matter how many tools the
 * agent calls. The promise itself is memoized so concurrent first calls share
 * a single JWKS round trip, and a rejection is not cached as a success.
 */
function createClaimsProvider(authorization: string | undefined, requestLogger: Logger) {
    let pending: Promise<VerifiedClaims> | null = null;

    return () => {
        if (!pending) {
            pending = verifyClaims(authorization).then((claims) => {
                requestLogger.info({
                    subject: claims.subject,
                    actor: claims.actor,
                    delegated: claims.delegated,
                    scopeCount: claims.scopes.length,
                }, "Bearer token verified at MCP boundary");

                return claims;
            }).catch((error) => {
                pending = null;
                throw error;
            });
        }

        return pending;
    };
}

/**
 * Wrap a tool handler so it runs only with a verified token that carries the
 * required scopes. The handler receives the verified claims, which are the only
 * source of identity for downstream calls -- never a model-supplied argument.
 */
function withAuthorization<T extends Record<string, unknown>, R>(
    getClaims: () => Promise<VerifiedClaims>,
    requiredScopes: string[],
    fn: (params: T, claims: VerifiedClaims) => Promise<R>,
) {
    return async (params: T): Promise<R | { isError: true; content: [{ type: "text"; text: string }] }> => {
        try {
            let claims: VerifiedClaims;

            if (requireAuth) {
                claims = await getClaims();
                requireScope(claims, requiredScopes, "all");
            } else {
                // Local demo mode: no identity provider configured. Tools still run,
                // but nothing here is an authorization decision.
                claims = await getClaims().catch(() => ({
                    subject: "local-demo-user",
                    delegated: false,
                    scopes: [],
                    roles: [],
                } satisfies VerifiedClaims));
            }

            return await fn(params, claims);
        } catch (error) {
            if (error instanceof AuthError) {
                return {
                    isError: true as const,
                    content: [{ type: "text" as const, text: error.code }],
                };
            }

            // A rejected data operation (unknown booking, not the caller's
            // booking, duplicate) is reported to the agent as a tool error so
            // the model can explain it, not thrown as a transport failure.
            if (error instanceof DataError) {
                return {
                    isError: true as const,
                    content: [{
                        type: "text" as const,
                        text: error.statusCode === 403 ? "forbidden" : error.message,
                    }],
                };
            }

            throw error;
        }
    };
}

function toToolContent(data: JsonValue) {
    return {
        content: [
            {
                type: "text" as const,
                text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
            },
        ],
    };
}

function createTravelMcpServer(authorization?: string, requestLogger: Logger = logger) {
    const getClaims = createClaimsProvider(authorization, requestLogger);
    const server = new McpServer({
        name: "wayfinder-travel-api",
        version: "1.0.0",
    });

    /**
     * The acting user, derived solely from the verified token. Tools pass this
     * to the data layer instead of accepting an owner argument, so a
     * model-supplied username can never decide whose data is read or written.
     */
    function getOwner(claims: VerifiedClaims) {
        return {
            id: claims.subject,
            username: claims.username || claims.email || claims.subject,
            ...(claims.email ? { email: claims.email } : {}),
        };
    }

    // Public catalogue reads. A valid token is still required when
    // MCP_REQUIRE_AUTH=true, but no scope beyond that.
    server.tool(
        "search_flights",
        "Search available flights from the travel API.",
        {
            from: z.string().optional().describe("Departure location, for example Colombo."),
            to: z.string().optional().describe("Arrival location, for example Singapore."),
        },
        withAuthorization(getClaims, scopesForTool("search_flights"), async ({ from, to }) => logToolOperation(requestLogger, "search_flights", { from, to }, async () => (
            toToolContent({ data: await searchFlights({ from, to }) as JsonValue })
        ))),
    );

    server.tool(
        "search_hotels",
        "Search available hotels from the travel API.",
        {
            location: z.string().optional().describe("Hotel location, for example Singapore."),
        },
        withAuthorization(getClaims, scopesForTool("search_hotels"), async ({ location }) => logToolOperation(requestLogger, "search_hotels", { location }, async () => (
            toToolContent({ data: await searchHotels({ location }) as JsonValue })
        ))),
    );

    server.tool(
        "get_trips",
        "Get saved trip ideas from the travel API.",
        {},
        withAuthorization(getClaims, scopesForTool("get_trips"), async () => logToolOperation(requestLogger, "get_trips", {}, async () => (
            toToolContent({ data: await listTrips() as JsonValue })
        ))),
    );

    server.tool(
        "get_locations",
        "Get available travel locations from the travel API.",
        {
            category: z.enum(["flights", "hotels"]).optional().describe("Optional location category."),
        },
        withAuthorization(getClaims, scopesForTool("get_locations"), async ({ category }) => logToolOperation(requestLogger, "get_locations", { category }, async () => (
            toToolContent({ data: await listLocations({ category }) as JsonValue })
        ))),
    );

    server.tool(
        "create_booking",
        "Create a booking for the authenticated user in the travel API.",
        {
            type: z.enum(["flight", "hotel"]).describe("Booking type."),
            itemId: z.string().describe("Flight or hotel item ID to book."),
            travelers: z.number().int().min(1).max(9).optional().describe("Number of travelers."),
        },
        withAuthorization(
            getClaims,
            scopesForTool("create_booking"),
            async ({ type, itemId, travelers }, claims) => logToolOperation(
                requestLogger,
                "create_booking",
                { type, itemId, travelers, subject: claims.subject },
                async () => toToolContent(await createBooking({
                    owner: getOwner(claims),
                    type,
                    itemId,
                    travelers: travelers ?? 1,
                }) as JsonValue),
            ),
        ),
    );

    server.tool(
        "get_flight_bookings",
        "Get flight bookings for the current authenticated user.",
        {},
        withAuthorization(
            getClaims,
            scopesForTool("get_flight_bookings"),
            async (_params, claims) => logToolOperation(
                requestLogger,
                "get_flight_bookings",
                { subject: claims.subject },
                async () => toToolContent({
                    data: await listFlightBookings(getOwner(claims).username) as JsonValue,
                }),
            ),
        ),
    );

    server.tool(
        "cancel_booking",
        "Cancel a flight booking belonging to the authenticated user.",
        {
            bookingId: z.string().describe("The flight booking ID to cancel."),
            preserveDealAlerts: z.boolean().optional().describe("When true, leave the booking's deal alerts enabled instead of disabling them."),
        },
        withAuthorization(
            getClaims,
            scopesForTool("cancel_booking"),
            async ({ bookingId, preserveDealAlerts }, claims) => logToolOperation(
                requestLogger,
                "cancel_booking",
                { bookingId, preserveDealAlerts, subject: claims.subject },
                async () => toToolContent({
                    // Ownership is enforced against the verified subject, so a
                    // booking id alone is not enough to cancel someone else's.
                    data: await cancelBooking({
                        bookingId: bookingId as string,
                        username: getOwner(claims).username,
                        preserveDealAlerts: preserveDealAlerts as boolean | undefined,
                    }) as JsonValue,
                }),
            ),
        ),
    );

    server.tool(
        "transfer_deal_alert_consent",
        "Move a better-deal alert consent from one of the authenticated user's bookings to another.",
        {
            fromBookingId: z.string().describe("Booking ID the consent is currently attached to."),
            toBookingId: z.string().describe("Booking ID to move the consent to."),
        },
        withAuthorization(
            getClaims,
            scopesForTool("transfer_deal_alert_consent"),
            async ({ fromBookingId, toBookingId }, claims) => logToolOperation(
                requestLogger,
                "transfer_deal_alert_consent",
                { fromBookingId, toBookingId, subject: claims.subject },
                async () => toToolContent({
                    // Both bookings must belong to the verified subject.
                    data: await transferDealAlertConsent({
                        fromBookingId: fromBookingId as string,
                        toBookingId: toBookingId as string,
                        username: getOwner(claims).username,
                    }) as JsonValue,
                }),
            ),
        ),
    );

    server.tool(
        "list_deal_alert_consents",
        "List enabled better-deal alert consents with current booking context for ambient flight matching.",
        {},
        withAuthorization(
            getClaims,
            scopesForTool("list_deal_alert_consents"),
            async (_params, claims) => logToolOperation(
                requestLogger,
                "list_deal_alert_consents",
                { subject: claims.subject },
                async () => toToolContent({ data: await listAllDealAlertConsents() as JsonValue }),
            ),
        ),
    );

    return server;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
        return undefined;
    }

    const body = Buffer.concat(chunks).toString("utf8");

    return body ? JSON.parse(body) : undefined;
}

function sendJson(response: ServerResponse, statusCode: number, body: JsonValue) {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}

const httpServer = createServer(async (request, response) => {
    const requestId = randomUUID();
    const startedAt = getStartTime();
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || host}`);
    const requestLogger = logger.child({
        requestId,
        method: request.method,
        path: requestUrl.pathname,
    });

    response.setHeader("X-Request-Id", requestId);
    response.on("finish", () => {
        requestLogger.info({
            statusCode: response.statusCode,
            durationMs: getDurationMs(startedAt),
        }, "HTTP request completed");
    });

    const authorizationHeader = getAuthorizationHeader(request);

    requestLogger.info({
        forwardedTokenClaims: getBearerTokenClaims(authorizationHeader),
        hasAuthorization: Boolean(authorizationHeader),
        contentLength: request.headers["content-length"],
    }, "HTTP request started");

    if (requestUrl.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });

        return;
    }

    if (requestUrl.pathname !== "/mcp") {
        sendJson(response, 404, { error: "Not found" });

        return;
    }

    if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" });

        return;
    }

    try {
        const server = createTravelMcpServer(authorizationHeader, requestLogger);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });
        const body = await readJsonBody(request);

        response.on("close", () => {
            requestLogger.debug("Closing MCP transport for HTTP response");
            transport.close();
        });

        await server.connect(transport);
        await transport.handleRequest(request, response, body);
    } catch (error) {
        requestLogger.error({ err: error }, "Error handling MCP request");

        if (!response.headersSent) {
            sendJson(response, 500, {
                error: error instanceof Error ? error.message : "Failed to handle MCP request.",
            });
        }
    }
});

// Open the database before accepting traffic, so a missing or unreadable
// Wayfinder database fails at startup rather than on the first tool call.
try {
    await initializeData();
    logger.info("Wayfinder database opened for in-process access");
} catch (error) {
    logger.error({ err: error }, "Failed to open the Wayfinder database");
    process.exit(1);
}

httpServer.listen(port, host, () => {
    logger.info({
        mcpUrl: `http://${host}:${port}/mcp`,
        healthUrl: `http://${host}:${port}/health`,
    }, "Travel MCP server started");
});
