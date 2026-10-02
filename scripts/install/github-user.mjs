import assert from "node:assert/strict";

const username = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const emailFallback = "GitHub could not identify one user by that public email. If your email is private, enter your GitHub username or profile URL instead.";

async function resolveUser(input, request = fetch) {
  const value = input.trim().replace(/^@/, "").replace(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?(?:[?#].*)?$/i, "$1");
  async function get(path) {
    const response = await request("https://api.github.com" + path, {
      headers: { "User-Agent": "sunpower-monitor-installer", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("GitHub user lookup failed: HTTP " + response.status);
    return response.json();
  }
  let user;
  if (username.test(value)) {
    user = await get("/users/" + encodeURIComponent(value));
  } else if (value.length <= 254 && /^[^\s@"<>\\]+@[^\s@"<>\\]+\.[^\s@"<>\\]+$/.test(value)) {
    const query = new URLSearchParams({ q: `"${value}" in:email type:user`, per_page: "2" });
    const result = await get("/search/users?" + query);
    if (result.incomplete_results !== false || result.total_count !== 1 || result.items?.length !== 1 || typeof result.items[0].login !== "string" || !username.test(result.items[0].login)) {
      throw new Error(emailFallback);
    }
    user = await get("/users/" + encodeURIComponent(result.items[0].login));
    if (typeof user.email !== "string" || user.email.toLowerCase() !== value.toLowerCase()) throw new Error(emailFallback);
  } else {
    throw new Error("Enter a GitHub username, https://github.com/USERNAME, or email address.");
  }
  if (user.type !== "User" || typeof user.login !== "string" || !username.test(user.login) || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error("GitHub did not return a valid personal user account.");
  }
  return user;
}

if (process.argv[2] === "--check") {
  const user = { login: "alice", id: 123456, type: "User", email: "alice@example.com" };
  const result = { incomplete_results: false, total_count: 1, items: [{ login: "alice" }] };
  const fake = (search = result, profile = user) => async (url) => ({
    ok: true,
    json: async () => new URL(url).pathname === "/search/users" ? search : profile,
  });
  for (const input of ["alice", " @alice ", "https://github.com/alice/", "https://github.com/alice?tab=repositories", "ALICE@example.com"]) {
    assert.equal((await resolveUser(input, fake())).id, 123456);
  }
  for (const search of [{ ...result, total_count: 0, items: [] }, { ...result, total_count: 2 }, { ...result, incomplete_results: true }]) {
    await assert.rejects(resolveUser("alice@example.com", fake(search)), /public email/);
  }
  for (const email of [null, "other@example.com"]) {
    await assert.rejects(resolveUser("alice@example.com", fake(result, { ...user, email })), /public email/);
  }
  for (const input of ["https://github.com/alice/project", "https://github.com.evil.example/alice", "alice@example.com in:login"]) {
    await assert.rejects(resolveUser(input, fake()), /Enter a GitHub/);
  }
  await assert.rejects(resolveUser("alice", fake(result, { ...user, type: "Organization" })), /personal user/);
  await assert.rejects(resolveUser("alice", fake(result, { ...user, login: undefined })), /personal user/);
  await assert.rejects(resolveUser("alice", async () => ({ ok: false, status: 403 })), /HTTP 403/);
  console.log("GitHub identity checks passed");
} else {
  try {
    const user = await resolveUser(process.argv[2] || "");
    console.log(user.login + "\t" + user.id);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
