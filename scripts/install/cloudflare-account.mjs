import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function accountsFrom(result) {
  if (!result.loggedIn || !Array.isArray(result.accounts) || result.accounts.length === 0 ||
      result.accounts.some((account) => !/^[a-fA-F0-9]{32}$/.test(account.id))) {
    throw new Error("No valid Cloudflare account found. Check that your account has Workers enabled.");
  }
  return result.accounts;
}

if (process.argv[2] === "--check") {
  const account = { id: "a".repeat(32), name: "Test account" };
  assert.deepEqual(accountsFrom({ loggedIn: true, accounts: [account] }), [account]);
  assert.equal(accountsFrom({ loggedIn: true, accounts: [account, { ...account, id: "b".repeat(32) }] }).length, 2);
  for (const result of [{ loggedIn: false }, { loggedIn: true, accounts: [] }, { loggedIn: true, accounts: [{ id: "invalid" }] }]) {
    assert.throws(() => accountsFrom(result), /No valid Cloudflare account/);
  }
  console.log("Cloudflare account checks passed");
} else {
  try {
    const accounts = accountsFrom(JSON.parse(execFileSync("npx", ["wrangler", "whoami", "--json"], { encoding: "utf8" })));
    if (accounts.length === 1) {
      console.error("Using Cloudflare account: " + accounts[0].name);
      process.stdout.write(accounts[0].id);
    } else {
      console.error("Choose the Cloudflare account where this dashboard should be installed:\n");
      for (const account of accounts) console.error("  " + account.name + "\n  Account ID: " + account.id + "\n");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
