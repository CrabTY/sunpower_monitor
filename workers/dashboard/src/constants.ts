/**
 * Shared constants.
 *
 * The Worker entry point must only export its default handler: extra named
 * exports are treated as additional worker entrypoints by workerd.
 */

export const SCHEMA_VERSION = 1;
export const SESSION_COOKIE = "spm_session";
export const OAUTH_COOKIE = "spm_oauth";
export const SESSION_SECONDS = 7 * 24 * 3600;
