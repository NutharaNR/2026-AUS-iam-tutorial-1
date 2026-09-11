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

/**
 * In-process data access for the MCP server.
 *
 * The MCP server owns its tool surface end to end: it authorizes at its own
 * boundary and then reads and writes the Wayfinder database directly, rather
 * than proxying to the REST API and inheriting whatever that layer decides.
 * This keeps identity single-sourced -- every query below is parameterised on
 * claims the MCP boundary verified -- and removes a second audience the token
 * would otherwise have to satisfy.
 *
 * The REST API still serves the browser and still opens the same SQLite file.
 * better-sqlite3 runs it in WAL mode, so concurrent readers and a single writer
 * are fine; a write racing another write surfaces as SQLITE_BUSY, which the
 * tool layer reports rather than retries.
 *
 * The API's db module is imported at runtime instead of built against: it is
 * plain JS with no type declarations, and its `dbPath` resolves from its own
 * module directory, so it opens the same file regardless of our cwd.
 */

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where the REST API's db module lives, overridable for non-default layouts. */
const apiDbModulePath = process.env.API_DB_MODULE
    ? resolve(process.env.API_DB_MODULE)
    : resolve(__dirname, "..", "api", "src", "db.ts");

type Row = Record<string, unknown>;

type ApiDbModule = {
    findFlights(criteria: { from?: string | null; to?: string | null; cabin?: string | null }): Row[];
    findHotels(criteria: { location?: string | null; maxNightlyRate?: number }): Row[];
    listTrips(criteria?: { destination?: string | null }): Row[];
    listLocations(criteria: { category?: string | null }): Row[];
    createBookingRecord(input: Row): Row;
    findDuplicateBooking(input: { username: string; type: string; itemId: string }): Row | undefined;
    listBookedFlights(username: string): Row[];
    cancelBookedFlight(input: { bookingId: string; username: string; disableDealAlerts?: boolean }): Row | null;
    transferDealAlertConsentBooking(input: {
        fromBookingId: string;
        toBookingId: string;
        username: string;
        now: string;
    }): Row | null;
    listAllEnabledDealAlertConsents(): Row[];
};

let modulePromise: Promise<ApiDbModule> | null = null;

/**
 * Loaded once and memoized. The promise itself is cached so concurrent first
 * calls share a single import, and a failure is not cached as a success.
 */
function getApiDb(): Promise<ApiDbModule> {
    if (!modulePromise) {
        modulePromise = import(pathToFileURL(apiDbModulePath).href)
            .then((loaded) => loaded as ApiDbModule)
            .catch((error) => {
                modulePromise = null;

                throw new Error(
                    `Failed to load the Wayfinder database module at ${apiDbModulePath}. `
                    + "Set API_DB_MODULE if the API lives elsewhere. "
                    + (error instanceof Error ? error.message : String(error)),
                );
            });
    }

    return modulePromise;
}

/** Open the database eagerly so a misconfigured path fails at startup. */
export async function initializeData() {
    await getApiDb();
}

function generateBookingReference() {
    return randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

export async function searchFlights(criteria: { from?: string; to?: string; cabin?: string }) {
    const db = await getApiDb();

    return db.findFlights({
        from: criteria.from ?? null,
        to: criteria.to ?? null,
        cabin: criteria.cabin ?? null,
    });
}

export async function searchHotels(criteria: { location?: string; maxNightlyRate?: number }) {
    const db = await getApiDb();

    // The REST layer coerces a missing rate to 0, which findHotels treats as
    // "no ceiling". Keep that behaviour so results match the previous surface.
    return db.findHotels({
        location: criteria.location ?? null,
        maxNightlyRate: criteria.maxNightlyRate ?? 0,
    });
}

export async function listTrips(criteria: { destination?: string } = {}) {
    const db = await getApiDb();

    return db.listTrips({ destination: criteria.destination ?? null });
}

export async function listLocations(criteria: { category?: string } = {}) {
    const db = await getApiDb();

    return db.listLocations({ category: criteria.category ?? null });
}

export class DataError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.name = "DataError";
        this.statusCode = statusCode;
    }
}

/**
 * Create a booking owned by `owner`, which the caller must derive from verified
 * claims. There is deliberately no way to name a different owner: the previous
 * REST hop resolved ownership from request headers, which made the owner
 * effectively caller-controlled.
 */
export async function createBooking(input: {
    owner: { id: string; username: string; email?: string };
    type: "flight" | "hotel";
    itemId: string;
    travelers: number;
}) {
    const db = await getApiDb();
    const { owner, type, itemId, travelers } = input;

    if (!Number.isInteger(travelers) || travelers < 1 || travelers > 9) {
        throw new DataError(400, "travelers must be an integer between 1 and 9");
    }

    if (db.findDuplicateBooking({ username: owner.username, type, itemId })) {
        throw new DataError(409, "This booking already exists.");
    }

    return db.createBookingRecord({
        id: `booking-${randomUUID()}`,
        bookingReference: generateBookingReference(),
        user: owner,
        type,
        itemId,
        travelers,
        status: "confirmed",
        createdAt: new Date().toISOString(),
    });
}

export async function listFlightBookings(username: string) {
    const db = await getApiDb();

    return db.listBookedFlights(username);
}

/**
 * Cancel a flight booking the caller owns.
 *
 * `username` must come from verified claims. The underlying query refuses to
 * cancel a booking owned by anyone else, but it compares against whatever name
 * it is given -- the REST route fed it a request header, so the check compared
 * a caller-supplied value against itself.
 */
export async function cancelBooking(input: {
    bookingId: string;
    username: string;
    preserveDealAlerts?: boolean;
}) {
    const db = await getApiDb();
    const booking = db.cancelBookedFlight({
        bookingId: input.bookingId,
        username: input.username,
        disableDealAlerts: input.preserveDealAlerts !== true,
    });

    // A null here is either "no such booking" or "not yours"; the query does not
    // distinguish them, and neither should the response -- telling the caller
    // which one would confirm that someone else's booking id exists.
    if (!booking) {
        throw new DataError(404, "Flight booking not found for the authenticated user");
    }

    return booking;
}

/**
 * Move a deal-alert consent from one of the caller's bookings to another.
 *
 * Both bookings must belong to `username`, which must come from verified claims
 * for the same reason as above.
 */
export async function transferDealAlertConsent(input: {
    fromBookingId: string;
    toBookingId: string;
    username: string;
}) {
    const db = await getApiDb();
    const consent = db.transferDealAlertConsentBooking({
        fromBookingId: input.fromBookingId,
        toBookingId: input.toBookingId,
        username: input.username,
        now: new Date().toISOString(),
    });

    if (!consent) {
        throw new DataError(404, "Deal alert consent could not be transferred for the authenticated user");
    }

    return consent;
}

/**
 * Every enabled consent across all users, with booking context.
 *
 * This is intentionally cross-user: the ambient agent has to scan all watchers
 * to match a new flight against them. It is therefore the widest read on the
 * tool surface and should stay gated to the ambient agent's scope alone.
 */
export async function listAllDealAlertConsents() {
    const db = await getApiDb();

    return db.listAllEnabledDealAlertConsents();
}
