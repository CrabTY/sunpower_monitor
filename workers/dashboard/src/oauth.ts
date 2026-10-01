/** GitHub OAuth (authorization code + PKCE). No repository scopes are requested. */

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type Fetcher = typeof fetch;

export function authorizeUrl(config: GithubConfig, state: string, challenge: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCode(
  fetcher: Fetcher,
  config: GithubConfig,
  code: string,
  verifier: string,
): Promise<string> {
  const response = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error(`github_token_${response.status}`);
  const payload = (await response.json()) as { access_token?: unknown; error?: unknown };
  if (typeof payload.error === "string" && [
    "incorrect_client_credentials", "redirect_uri_mismatch", "bad_verification_code", "unverified_user_email",
  ].includes(payload.error)) {
    throw new Error(`github_token_${payload.error}`);
  }
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("github_token_missing");
  }
  return payload.access_token;
}

export async function fetchUserId(fetcher: Fetcher, accessToken: string): Promise<string> {
  const response = await fetcher("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "sunpower-monitor-dashboard",
    },
  });
  if (!response.ok) throw new Error(`github_user_${response.status}`);
  const payload = (await response.json()) as { id?: unknown };
  if (typeof payload.id !== "number" && typeof payload.id !== "string") throw new Error("github_user_id_missing");
  return String(payload.id);
}

export function isAllowedUser(userId: string, allowlist: string): boolean {
  return allowlist
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(userId);
}

/** Return only our fixed diagnostic codes, never provider payloads or credentials. */
export function oauthFailureCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /^github_(token_([1-5]\d{2}|missing|incorrect_client_credentials|redirect_uri_mismatch|bad_verification_code|unverified_user_email)|user_([1-5]\d{2}|id_missing))$/.test(code)
    ? code : "unknown";
}
