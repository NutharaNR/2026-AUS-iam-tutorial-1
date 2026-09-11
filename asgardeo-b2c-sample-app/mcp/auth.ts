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

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Scopes the MCP tool surface gates on, keyed by the tool they guard. These are
 * namespaced under `mcp:` and registered on their own API resource, so a token
 * minted for the agent path is not interchangeable with one minted for the
 * Wayfinder REST API -- replaying either against the other fails verification.
 *
 * Each name must be registered as a scope on that API resource and granted to
 * the agent's role, or tokens come back without it and the tool returns
 * insufficient_scope.
 *
 * Tools absent from this map are not scope-gated: they still require a verified
 * token, but no particular scope. Add an entry here once its scope is registered.
 */
export const ToolScope = {
    search_flights: ["mcp:search_flights"],
    get_locations: ["mcp:get_locations"],
    create_booking: ["mcp:create_bookings"],
    list_deal_alert_consents: ["mcp:deal-alert-consents:read"],
    cancel_booking: ["mcp:create_bookings"],
    transfer_deal_alert_consent: ["mcp:deal-alert-consents:write"],
} as const;

/** Scopes required by a tool. Empty means authenticated-but-ungated. */
export function scopesForTool(tool: string): string[] {
    const scopes = (ToolScope as Record<string, readonly string[] | undefined>)[tool];

    return scopes ? [...scopes] : [];
}

export class AuthError extends Error {
    readonly code: "invalid_token" | "insufficient_scope";

    constructor(code: "invalid_token" | "insufficient_scope", message: string) {
        super(message);
        this.name = "AuthError";
        this.code = code;
    }
}

export type VerifiedClaims = {
    /** Verified end-user subject. The only trustworthy identity for data scoping. */
    subject: string;
    /** Actor subject from the `act` claim -- the agent, when acting on behalf of a user. */
    actor?: string;
    /** True when the token is a delegated (on-behalf-of) token rather than the agent's own. */
    delegated: boolean;
    username?: string;
    email?: string;
    scopes: string[];
    roles: string[];
};

function getBaseUrl() {
    const baseUrl = process.env.ASGARDEO_BASE_URL?.trim();

    if (!baseUrl) {
        throw new Error("ASGARDEO_BASE_URL is required when MCP_REQUIRE_AUTH=true");
    }

    return baseUrl.replace(/\/+$/, "");
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Cached across sessions -- jose handles its own key rotation and refresh. */
function getJwks() {
    if (!jwks) {
        jwks = createRemoteJWKSet(new URL(`${getBaseUrl()}/oauth2/jwks`));
    }

    return jwks;
}

function getExpectedIssuer() {
    return process.env.ASGARDEO_ISSUER?.trim() || `${getBaseUrl()}/oauth2/token`;
}

function getExpectedAudiences() {
    return (process.env.ASGARDEO_AUDIENCE || "")
        .split(/[,\s]+/)
        .map((value) => value.trim())
        .filter(Boolean);
}

function toStringList(value: unknown): string[] {
    if (typeof value === "string") {
        return value.split(/\s+/).filter(Boolean);
    }

    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
            .map((entry) => entry.trim());
    }

    return [];
}

function getActorSubject(payload: JWTPayload) {
    const actor = payload.act;

    if (actor && typeof actor === "object" && !Array.isArray(actor)) {
        const subject = (actor as Record<string, unknown>).sub;

        return typeof subject === "string" ? subject : undefined;
    }

    return undefined;
}

/**
 * Verify a bearer token's signature against the identity provider's JWKS and
 * validate issuer, audience and expiry. Returns only claims that survived
 * verification -- callers must not read identity from anywhere else.
 */
export async function verifyClaims(authorization: string | undefined): Promise<VerifiedClaims> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";

    if (!token) {
        throw new AuthError("invalid_token", "Missing bearer token");
    }

    const audiences = getExpectedAudiences();

    if (audiences.length === 0) {
        throw new Error("ASGARDEO_AUDIENCE is required when MCP_REQUIRE_AUTH=true");
    }

    let payload: JWTPayload;

    try {
        ({ payload } = await jwtVerify(token, getJwks(), {
            issuer: getExpectedIssuer(),
            audience: audiences,
            algorithms: ["RS256"],
        }));
    } catch (error) {
        throw new AuthError(
            "invalid_token",
            error instanceof Error ? error.message : "Bearer token verification failed",
        );
    }

    if (typeof payload.sub !== "string" || !payload.sub) {
        throw new AuthError("invalid_token", "Token is missing a subject claim");
    }

    const actor = getActorSubject(payload);
    const scopes = [
        ...toStringList(payload.scope),
        ...toStringList(payload.scp),
    ];

    return {
        subject: payload.sub,
        actor,
        delegated: Boolean(actor) && actor !== payload.sub,
        username: typeof payload.username === "string"
            ? payload.username
            : typeof payload.preferred_username === "string"
                ? payload.preferred_username
                : undefined,
        email: typeof payload.email === "string" ? payload.email : undefined,
        scopes,
        roles: toStringList(payload.roles),
    };
}

/**
 * Require scopes on already-verified claims.
 *
 * Unlike the REST API's check, `roles` and `permissions` are NOT pooled into
 * the scope set here: a role name must not stand in for a granted scope at the
 * MCP boundary.
 */
export function requireScope(
    claims: VerifiedClaims,
    required: string[],
    match: "any" | "all" = "all",
) {
    if (required.length === 0) {
        return;
    }

    const granted = new Set(claims.scopes);
    const satisfied = match === "any"
        ? required.some((scope) => granted.has(scope))
        : required.every((scope) => granted.has(scope));

    if (!satisfied) {
        throw new AuthError(
            "insufficient_scope",
            `Missing required scope. Expected ${match === "any" ? "one of" : "all of"}: ${required.join(", ")}`,
        );
    }
}
