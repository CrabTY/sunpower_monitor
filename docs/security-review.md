# Security review

Reviewed on **2026-10-01**, using Codex Security with independent source review and local checks of the pre-release source snapshot. The reviewed revision and sealed audit evidence are retained in the maintainer's private records. This is an AI-assisted maintainer review, not an independent security certification.

## Scope and results

The review covered the collector, local queue and credential handling, installers and release/deployment scripts, Cloudflare Workers, OAuth and sessions, ingest validation and SQL, browser rendering, development tools, tests, and dependency lock metadata. Generated knowledge graphs and binary documentation images were excluded. No production account, telemetry, or credentials were accessed.

| Check | Result at the reviewed commit |
| --- | --- |
| Source review | One low-severity finding; no medium, high, or critical finding validated |
| Semgrep CE 1.178.0, `p/ci` | Initial application scan: no findings. Expanded scan: 12 mutable Actions references and one intentional loopback HTTP documentation link; some rules timed out |
| `npm audit --audit-level=high` | No reported dependency vulnerabilities |
| Gitleaks 8.30.1 | No secrets detected in the current source snapshot |
| TypeScript compilation | Passed |

**Finding at the reviewed commit:** a cross-origin request could force a dashboard user to sign out because logout lacked the origin check used by other state-changing routes. No telemetry disclosure or unauthorized settings change was established.

**Local remediation, 2026-10-01:** the logout route now uses the existing origin guard before cookie clearing. The new regression failed against the original source and passes with the fix: foreign and `null` origins, missing Origin with cross-site metadata, and a foreign origin with misleading fetch metadata all return `403` without `Set-Cookie`, for both HTML and JSON responses. Same-origin browser logout and headerless command-line logout still work. The full `npm run check` passed under Node 24.19.0, including 81 Worker tests. Independent patch review found no concrete bypass or regression. Production deployment is pending; no real browser or production Cloudflare validation was performed. The original sealed audit report remains a record of the earlier commit.

The full report and validation evidence are retained in the maintainer's Codex Security scan. This public summary omits deployment details and exploit instructions.

## Continuing checks

[Security Actions](https://github.com/CrabTY/sunpower_monitor/actions/workflows/security.yml) runs Semgrep, dependency auditing, and Gitleaks on pull requests, pushes to `main`, and weekly. Semgrep covers application code, developer scripts, deployment files, and Actions; static documentation is covered by the source review. The new configuration pins existing Actions references to verified commits; this addresses the expanded scan's mutable-reference warnings. Dependabot proposes npm and Actions updates weekly. Gitleaks CI checks Git history, disables automatic PR comments, and avoids uploading secret reports. The initial local Gitleaks check covered the snapshot only; subsequent GitHub runs passed the history check for the current release.

The release workflow calls this same security workflow and requires all three jobs to pass before publishing images or Release assets. The dependency gate fails on high or critical advisories. Semgrep fails on findings in its configured rules; rule timeouts can limit coverage. Passing these checks does not establish complete coverage. The main-branch checks and the v0.1.0 release gate have completed successfully on GitHub. The README badge links to the latest main-branch results.

The follow-up configuration was checked locally: `actionlint` passed for all workflows, Semgrep's exact CI command reported zero findings across 71 files with 50 executed rules and seven warnings limiting coverage, and Gitleaks found no secrets in the updated snapshot. These checks are separate from the source audit of the commit above.

## Limits and deployment responsibilities

The review did not verify deployed Cloudflare/GitHub permissions, browser cookie behavior, external services, dependency implementation, electrical safety, or production operation. It did not perform penetration testing or review every historical commit. Scan results describe this commit and the advisory/rule data available at the time.

Each deployment serves one trusted household. Operators must keep ingest tokens, OAuth credentials, session secrets, and telemetry private, use HTTPS cloud endpoints, and maintain the GitHub user allowlist. Authorized dashboard users can change location and calibration. Session cookies are stateless and expire after seven days; there is no individual server-side session revocation. The LAN PVS client disables certificate verification for the device's self-signed certificate, so its network must be trusted. Optional location services receive configured location data; browser geolocation reaches the Worker before storage rounding.

Use GitHub private vulnerability reporting when enabled. The repository is currently private; if it becomes public, enable private reporting before inviting vulnerability submissions. No public contact email is provided.
