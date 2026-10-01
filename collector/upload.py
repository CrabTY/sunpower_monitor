"""Ingest client: discardable latest-value PUTs and idempotent history batches.

Acknowledgment rules from the architecture document: keep and back off on
network errors, timeouts, 429, and 5xx; stop and report authentication trouble
on 401/403; isolate rejected 4xx records so the queue can advance.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from .model import SCHEMA_VERSION

LIVE_PATH = "/api/v1/live"
RECORDS_PATH = "/api/v1/records"
# Cloudflare's edge answers the default Python-urllib User-Agent with 403, so
# identify the collector explicitly. Token checks still run in the Worker.
USER_AGENT = "sunpower-monitor-collector/0.1"


class UploadError(Exception):
    """Base class for ingest failures."""


class AuthError(UploadError):
    """The upload token was rejected; stop sending until an operator acts."""


class RetryableError(UploadError):
    """Network trouble, timeout, 429, or 5xx: keep the records and retry later."""


class RejectedError(UploadError):
    """The batch was rejected; isolate these record IDs and keep the rest."""

    def __init__(self, record_ids: list[str], message: str):
        super().__init__(message)
        self.record_ids = record_ids


class IngestClient:
    """HTTPS client for one ingest origin. Certificates are validated normally."""

    def __init__(self, base_url: str, token: str, *, timeout: float = 20.0, opener=None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.opener = opener or urllib.request.build_opener()
        self._token = token

    def _send(self, method: str, path: str, payload: dict) -> tuple[int, dict | None]:
        body = json.dumps(payload, separators=(",", ":")).encode()
        request = urllib.request.Request(
            self.base_url + path,
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return response.status, _parse_json(response.read())
        except urllib.error.HTTPError as exc:
            body = _parse_json(exc.read())
            exc.close()
            return exc.code, body
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise RetryableError(f"ingest unreachable: {type(exc).__name__}") from None

    def put_live(self, payload: dict) -> None:
        status, body = self._send("PUT", LIVE_PATH, payload)
        if status not in (200, 204):
            self._raise(status, body, [])

    def post_records(self, collector_id: str, records: list[dict]) -> list[str]:
        """Return the accepted record IDs; the caller deletes exactly those."""
        if not records:
            return []
        ids = [record["record_id"] for record in records]
        body = {"schema_version": SCHEMA_VERSION, "collector_id": collector_id, "records": records}
        status, response = self._send("POST", RECORDS_PATH, body)
        if status in (200, 204):
            accepted = (response or {}).get("accepted_ids")
            return accepted if isinstance(accepted, list) else ids
        self._raise(status, response, ids)

    def _raise(self, status: int, body: dict | None, ids: list[str]) -> None:
        if status in (401, 403):
            raise AuthError(f"ingest rejected the upload token with status {status}")
        if status == 429 or status >= 500:
            raise RetryableError(f"ingest returned status {status}")
        conflicting = _ids_from(body) or ids
        raise RejectedError(conflicting, f"ingest rejected {len(conflicting)} record(s) with status {status}")


def _parse_json(body: bytes) -> dict | None:
    try:
        parsed = json.loads(body)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _ids_from(body: dict | None) -> list[str]:
    if not body:
        return []
    for field in ("conflicting_ids", "invalid_ids", "rejected_ids"):
        value = body.get(field)
        if isinstance(value, list):
            return [str(item) for item in value]
    return []
