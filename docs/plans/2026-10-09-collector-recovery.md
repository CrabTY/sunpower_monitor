# Collector Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve actionable failure evidence, honor the documented retry cadence, and report current collector state accurately after an outage.

**Architecture:** Keep the serialized reader, focused PVS queries, queue and cloud contract. Extend safe exception diagnostics and the existing per-group state; use monotonic observation time for freshness and restart detection.

**Tech Stack:** Python standard library and unittest; existing collector and ingest contract.

---

## Review and release boundary

Prepare and test locally. The user must review the private incident postmortem before deciding on Git push, release publication and production deployment. No device reboot, new PVS query, cloud/schema change or historical backfill is part of this patch.

## Task 1: Write fault regressions

**Files:** `tests/test_pvs.py`, `tests/test_collector.py`.

Cover distinct safe diagnostics for HTTP, timeout, transport and malformed JSON; verify secret-bearing exception text never reaches logs. Assert every post-threshold failed read remains 60 seconds apart, successful recovery restores its normal cadence, and healthy groups continue running. Assert stale heartbeat readings are null/zero with explicit age. Test a reboot whose new uptime exceeds the previous observation after a long outage, including wall-clock movement and a missing uptime observation.

Run the targeted regressions before implementation and confirm they fail for the intended reasons.

## Task 2: Fix the shared paths

**Files:** `collector/pvs.py`, `collector/main.py`, `collector/model.py`.

Use fixed diagnostic labels plus numeric HTTP status, errno and elapsed milliseconds; never log arbitrary exception text, response bodies, URLs or headers. Retain the failure count until a successful read so the cooldown remains active. Track successful read times in existing group state. Preserve valid uptime observation time before reauthentication, compare uptime progression with monotonic elapsed time, and log the estimated boot time separately from restart detection time.

Retain legacy exception classes and minute error identifiers. New diagnostic data uses existing logs and free-form collector event details; no Worker deployment is required.

## Task 3: Verify and document

**Files:** `docs/architecture.md`, updated tests, private incident postmortem in the original checkout.

Run targeted regressions, the complete Python test suite and the module self-checks. Record validation results, limitations, the authorized AP unlock and its verification screenshot in the postmortem. Keep the reviewable branch unpushed and unreleased. Document a collector-only deployment and rollback procedure for later approval.
