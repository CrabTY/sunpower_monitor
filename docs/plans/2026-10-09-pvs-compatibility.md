# PVS Compatibility Implementation Plan

**Goal:** Absorb official varserver compatibility evidence without replacing the SDK or increasing installer prompts.

**Architecture:** Keep the synchronous PVS client, scheduler, normalized records and cloud contract. Normalize documented response shapes at the LAN boundary; share bounded session recovery across reads. Extend the existing read-only check with safe model/revision diagnostics and explicit capability evidence.

**Tech stack:** Python standard library; existing unittest suite. No runtime dependency added.

**Status:** Implemented and deployed/tested on Raspberry Pi with PVS6 `2025.10.20.61846`. Python: 87 passed, two local-ingest integration tests skipped, both on the development host and in the ARM64 image. Installer mock flow, static-site build/check, introduction interaction/route checks, SDK characterization and diff checks passed. Real acceptance: two inverter/health cycles, two meters, 21 panels, five complete cloud minutes with quality `ok`, zero restarts/backlog, and preserved panel identity mapping. See [hardware acceptance](../pvs-compatibility.md#hardware-acceptance).

## Scope and accepted design

- `collector/pvs.py`: accept flat objects and validated name/value envelopes; recover authentication once for grouped, health and gateway reads; allowlisted model/revision query.
- `collector/model.py`: accept documented nested device data alongside flat fields, preserving unknown values and AC/DC separation. Filter gateway diagnostics to recognized models and numeric version strings.
- `collector/main.py`: report safe gateway diagnostics on startup; extend `--check` to reject unusable core site data, and report empty/partial device groups as unverified rather than claiming absence. Metadata failure does not block otherwise usable reads.
- Tests: exercise both response shapes, malformed envelopes, nested device fields, bounded 403/errorcode recovery, safe metadata and read-check success/degradation/failure.
- README, architecture, references and ADR: distinguish documented candidates from hardware-verified configurations; credit official API/variable tables.
- Existing installer call, queue, cloud contracts and polling intervals remain in place. Initial implementation used synthetic checks; the subsequent authorized Raspberry Pi rollout added real-device acceptance.

## Steps

1. Add focused failing tests to `tests/test_pvs.py` and `tests/test_collector.py`. Run `python3.11 -m unittest tests.test_pvs tests.test_collector`.
2. Implement transport normalization/recovery and parser compatibility. Rerun focused tests.
3. Implement gateway diagnostics and read-only capability reporting; update test fixtures and callers.
4. Update compatibility documentation and ADR with implemented versus unverified behavior.
5. Run `python3.11 -m unittest discover -s tests`, `python3.11 scripts/checks/install-check.py`, and `git diff --check`. Inspect diff and commit with the required coauthor footer.

## Evidence limits

Official CSV path/type agreement is schema evidence, not proof of authentication, freshness, calibration or device membership on real firmware. Synthetic tests must be labelled synthetic; PVS5 battery fields marked NOT USED do not establish storage support. Do not add version-based routing or claim verified PVS5 support.
