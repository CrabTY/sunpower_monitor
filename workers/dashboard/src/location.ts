/**
 * Site location: candidate lookup, validation, and the confirmed row.
 *
 * Candidates are never saved here. The page shows what the provider returned
 * and calls PUT /api/v1/location only after the user confirms one. Coordinates
 * are rounded to about 100 m before they are returned or stored: weather and
 * daylight need nothing finer, and the exact position stays off the cloud.
 */

export const MAX_QUERY_LENGTH = 100;
export const MAX_ADDRESS_LENGTH = 200;
export const RESOLVE_LIMIT = 10;
export const RESOLVE_WINDOW_SECONDS = 300;
export const LOCATION_SOURCES = ["browser_geolocation", "open_meteo_geocoding", "us_census", "manual"] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]{0,31}(\/[A-Za-z0-9_+-]{1,63}){0,2}$/;
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const TIMEZONE_URL = "https://api.open-meteo.com/v1/forecast";

export interface Place {
  label: string;
  latitude: number;
  longitude: number;
  timezone: string | null;
  source: LocationSource;
}

export interface StoredLocation {
  latitude: number;
  longitude: number;
  timezone: string;
  source: string;
  updated_ts: number;
}

export type ResolveInput =
  | { kind: "query"; value: string }
  | { kind: "address"; value: string }
  | { kind: "coordinates"; latitude: number; longitude: number; source: "browser_geolocation" | "manual" };

export interface Validation<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidCoordinate(latitude: unknown, longitude: unknown): boolean {
  return (
    isFiniteNumber(latitude) &&
    isFiniteNumber(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** Pattern first, then the runtime's own zone table, so junk never gets stored. */
export function isValidTimezone(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  if (!TIMEZONE_PATTERN.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function parseResolveInput(body: unknown): Validation<ResolveInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "body" };
  const input = body as Record<string, unknown>;
  const kind = input.kind;
  if (kind === "query" || kind === "address") {
    const value = typeof input.value === "string" ? input.value.trim() : "";
    const limit = kind === "query" ? MAX_QUERY_LENGTH : MAX_ADDRESS_LENGTH;
    if (value.length === 0) return { ok: false, error: "value" };
    if (value.length > limit) return { ok: false, error: "value_too_long" };
    return { ok: true, value: { kind, value } };
  }
  if (kind === "coordinates") {
    const latitude = input.latitude;
    const longitude = input.longitude;
    if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude) || !isValidCoordinate(latitude, longitude)) {
      return { ok: false, error: "invalid_coordinates" };
    }
    const source = input.source === "browser_geolocation" ? "browser_geolocation" : "manual";
    return {
      ok: true,
      value: { kind, latitude: roundCoordinate(latitude), longitude: roundCoordinate(longitude), source },
    };
  }
  return { ok: false, error: "kind" };
}

export function parseLocationBody(body: unknown): Validation<{ latitude: number; longitude: number; timezone: string; source: LocationSource }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "body" };
  const input = body as Record<string, unknown>;
  if (!isValidCoordinate(input.latitude, input.longitude)) return { ok: false, error: "invalid_coordinates" };
  if (!isValidTimezone(input.timezone)) return { ok: false, error: "invalid_timezone" };
  if (!LOCATION_SOURCES.includes(input.source as LocationSource)) return { ok: false, error: "source" };
  return {
    ok: true,
    value: {
      latitude: roundCoordinate(input.latitude as number),
      longitude: roundCoordinate(input.longitude as number),
      timezone: input.timezone as string,
      source: input.source as LocationSource,
    },
  };
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { "User-Agent": "sunpower-monitor/0.1" } });
  if (!response.ok) throw new Error(`geocoder_http_${response.status}`);
  return response.json();
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Coordinates to IANA zone: Open-Meteo echoes the zone it resolved for them. */
export async function timezoneFor(fetchImpl: typeof fetch, latitude: number, longitude: number): Promise<string | null> {
  const payload = await getJson(
    fetchImpl,
    `${TIMEZONE_URL}?latitude=${latitude}&longitude=${longitude}&timezone=auto&current=temperature_2m`,
  );
  const zone = (payload as { timezone?: unknown } | null)?.timezone;
  return isValidTimezone(zone) ? (zone as string) : null;
}

export async function searchPlaces(fetchImpl: typeof fetch, query: string): Promise<Place[]> {
  const payload = (await getJson(
    fetchImpl,
    `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=5&language=en&format=json`,
  )) as { results?: unknown } | null;
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const places: Place[] = [];
  for (const result of results) {
    const row = result as Record<string, unknown>;
    if (!isValidCoordinate(row.latitude, row.longitude)) continue;
    const label = [text(row.name), text(row.admin1), text(row.country)].filter(Boolean).join(", ");
    places.push({
      label: label.length > 0 ? label : `${roundCoordinate(row.latitude as number)}, ${roundCoordinate(row.longitude as number)}`,
      latitude: roundCoordinate(row.latitude as number),
      longitude: roundCoordinate(row.longitude as number),
      timezone: isValidTimezone(row.timezone) ? (row.timezone as string) : null,
      source: "open_meteo_geocoding",
    });
  }
  return places;
}

export async function censusPlaces(fetchImpl: typeof fetch, address: string): Promise<Place[]> {
  const payload = (await getJson(
    fetchImpl,
    `${CENSUS_URL}?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`,
  )) as { result?: { addressMatches?: unknown } } | null;
  const matches = payload?.result?.addressMatches;
  if (!Array.isArray(matches)) return [];
  const matchesPlaces: Place[] = [];
  for (const match of matches.slice(0, 5)) {
    const row = match as Record<string, unknown>;
    const coordinates = row.coordinates as Record<string, unknown> | undefined;
    const latitude = coordinates?.y;
    const longitude = coordinates?.x;
    if (!isValidCoordinate(latitude, longitude)) continue;
    matchesPlaces.push({
      label: text(row.matchedAddress) ?? `${roundCoordinate(latitude as number)}, ${roundCoordinate(longitude as number)}`,
      latitude: roundCoordinate(latitude as number),
      longitude: roundCoordinate(longitude as number),
      timezone: await timezoneFor(fetchImpl, latitude as number, longitude as number),
      source: "us_census",
    });
  }
  return matchesPlaces;
}

export async function resolvePlaces(
  fetchImpl: typeof fetch,
  input: ResolveInput,
): Promise<Validation<Place[]>> {
  try {
    if (input.kind === "query") return { ok: true, value: await searchPlaces(fetchImpl, input.value) };
    if (input.kind === "address") return { ok: true, value: await censusPlaces(fetchImpl, input.value) };
    return {
      ok: true,
      value: [
        {
          label: `${input.latitude}, ${input.longitude}`,
          latitude: input.latitude,
          longitude: input.longitude,
          timezone: await timezoneFor(fetchImpl, input.latitude, input.longitude),
          source: input.source,
        },
      ],
    };
  } catch {
    return { ok: false, error: "geocoder_unavailable" };
  }
}

/**
 * Per-isolate counter: enough to stop a stuck page retry loop. Upgrade to a
 * durable counter if the dashboard ever serves more than one household.
 */
const resolveHits = new Map<string, number[]>();

export function allowResolve(key: string, nowSeconds: number): boolean {
  const recent = (resolveHits.get(key) ?? []).filter((ts) => nowSeconds - ts < RESOLVE_WINDOW_SECONDS);
  if (recent.length >= RESOLVE_LIMIT) {
    resolveHits.set(key, recent);
    return false;
  }
  recent.push(nowSeconds);
  resolveHits.set(key, recent);
  return true;
}

export async function readLocation(db: D1Database, collectorId: string): Promise<StoredLocation | null> {
  const row = await db
    .prepare("SELECT latitude, longitude, timezone, source, updated_ts FROM site_location WHERE collector_id = ? LIMIT 1")
    .bind(collectorId)
    .first<StoredLocation>();
  if (!row || !isValidCoordinate(row.latitude, row.longitude) || !isValidTimezone(row.timezone)) return null;
  return row;
}

export async function saveLocation(
  db: D1Database,
  collectorId: string,
  place: { latitude: number; longitude: number; timezone: string; source: string },
  updatedTs: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO site_location (collector_id, latitude, longitude, timezone, source, updated_ts)" +
        " VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(collector_id) DO UPDATE SET latitude = excluded.latitude," +
        " longitude = excluded.longitude, timezone = excluded.timezone, source = excluded.source, updated_ts = excluded.updated_ts",
    )
    .bind(collectorId, place.latitude, place.longitude, place.timezone, place.source, updatedTs)
    .run();
}
