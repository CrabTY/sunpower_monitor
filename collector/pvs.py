"""Read-only PVS varserver client: focused, serialized queries.

Boundaries taken from ``pilot.py`` and the architecture document:
only ``match=livedata``, ``match=meter``, ``match=inverter``, and three
``/sys/info/*`` health fields plus serial/model/revision diagnostics are requested;
the full ``match=/`` tree, device list, and ``/vars?set=`` are never called. Credentials live in memory
only. The self-signed LAN certificate exception applies to this LAN device;
cloud uploads must validate certificates.
"""

from __future__ import annotations

import base64
import http.cookiejar
import json
import ssl
import time
import urllib.error
import urllib.request

REQUEST_TIMEOUT = 8.0
MIN_REQUEST_GAP = 3.0
HEALTH_PATH = "/vars?name=/sys/info/uptime,/sys/info/cpu_usage,/sys/info/flash_usage&fmt=obj"
SERIAL_PATH = "/vars?name=/sys/info/serialnum&fmt=obj"
GATEWAY_PATH = "/vars?name=/sys/info/model,/sys/info/sw_rev&fmt=obj"
CACHES = {"livedata": "ldata", "meter": "mdata", "inverter": "idata"}


class PVSError(RuntimeError):
    """A PVS read failed: transport, malformed response, or repeated auth failure."""

    def __init__(self, message, *, reason="unknown", stage="read", http_status=None, errno=None, latency_ms=None):
        super().__init__(message)
        self.diagnostics = {"reason": reason, "stage": stage}
        self.diagnostics.update({key: value for key, value in
                                 (("http_status", http_status), ("errno", errno), ("latency_ms", latency_ms))
                                 if value is not None})


class PVSAuthError(PVSError):
    """The PVS rejected the session with HTTP 401/403."""

    def __init__(self, status: int, **diagnostics):
        super().__init__(f"pvs authentication rejected with status {status}", reason="http", http_status=status, **diagnostics)
        self.status = status


class PVSClient:
    """One serialized read-only connection to a PVS varserver on the LAN."""

    def __init__(
        self,
        host: str,
        *,
        timeout: float = REQUEST_TIMEOUT,
        min_gap: float = MIN_REQUEST_GAP,
        opener=None,
        sleep=time.sleep,
        monotonic=time.monotonic,
    ):
        self.host = host
        self.timeout = timeout
        self.min_gap = min_gap
        self._cookies = http.cookiejar.CookieJar()
        self.opener = opener or _build_opener(self._cookies)
        self._sleep = sleep
        self._monotonic = monotonic
        self._last_request = float("-inf")
        self.authenticate()

    def _request(self, path: str, headers: dict | None = None, *, stage="read") -> tuple[dict, int]:
        gap = self.min_gap - (self._monotonic() - self._last_request)
        if gap > 0:
            self._sleep(gap)
        request = urllib.request.Request(f"https://{self.host}{path}", headers=headers or {})
        started = self._monotonic()
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            exc.close()
            elapsed = round(max(0.0, self._monotonic() - started) * 1000)
            if exc.code in (401, 403):
                raise PVSAuthError(exc.code, stage=stage, latency_ms=elapsed) from None
            raise PVSError(f"pvs request failed with status {exc.code}", reason="http", stage=stage,
                           http_status=exc.code, latency_ms=elapsed) from None
        except (urllib.error.URLError, OSError, ValueError) as exc:
            cause = exc.reason if isinstance(exc, urllib.error.URLError) else exc
            reason = "timeout" if isinstance(cause, TimeoutError) else "transport"
            # Only fixed labels and numeric errno survive; exception text can contain credentials.
            error_number = cause.errno if isinstance(cause, OSError) else None
            error_number = error_number if type(error_number) is int else None
            raise PVSError(f"pvs request failed: {type(exc).__name__}", reason=reason, stage=stage,
                           errno=error_number, latency_ms=round(max(0.0, self._monotonic() - started) * 1000)) from None
        finally:
            self._last_request = self._monotonic()
        latency = round(max(0.0, self._last_request - started) * 1000)
        try:
            data = json.loads(body)
        except ValueError:
            raise PVSError("pvs response was not valid JSON", reason="invalid_json", stage=stage, latency_ms=latency) from None
        if not isinstance(data, dict):
            raise PVSError("pvs response was not a JSON object", reason="invalid_json", stage=stage, latency_ms=latency)
        if "values" in data and "errorcode" not in data:
            values = data["values"]
            normalized = {}
            if not isinstance(values, list):
                raise PVSError("pvs values were not an array", reason="invalid_json", stage=stage, latency_ms=latency)
            for item in values:
                if (not isinstance(item, dict) or not isinstance(item.get("name"), str)
                        or not item["name"].startswith("/") or "value" not in item or item["name"] in normalized):
                    raise PVSError("pvs values contained an invalid entry", reason="invalid_json", stage=stage, latency_ms=latency)
                normalized[item["name"]] = item["value"]
            data = normalized
        return data, latency

    def authenticate(self) -> None:
        """Derive the in-memory session credential from a focused serial read."""
        # The PVS answers 401 to every request that carries a stale session cookie,
        # including the serial read that login needs, so start from a clean jar.
        self._cookies.clear()
        data, _ = self._request(SERIAL_PATH, stage="serial")
        serial = data.get("/sys/info/serialnum")
        if not isinstance(serial, str) or len(serial) < 5:
            raise PVSError("pvs serial read did not return a usable value", reason="invalid_serial", stage="serial")
        credential = base64.b64encode(f"ssm_owner:{serial[-5:]}".encode()).decode()
        try:
            self._request("/auth?login", {"Authorization": f"Basic {credential}"}, stage="auth")
        except PVSAuthError as exc:
            raise PVSError("pvs authentication failed", **exc.diagnostics) from None
        finally:
            del credential

    def _read(self, path: str, *, stage="read") -> tuple[dict, int]:
        """Every read gets at most one session refresh, regardless of rejection format."""
        for attempt in range(2):
            try:
                data, latency = self._request(path, stage=stage)
            except PVSAuthError:
                if attempt:
                    raise
            else:
                if "errorcode" not in data:
                    return data, latency
                if attempt:
                    raise PVSError("pvs read returned an error response", reason="device_error", stage=stage, latency_ms=latency)
            self.authenticate()

    def read_group(self, group: str) -> tuple[dict, int]:
        # Every read names its group. A cache-only query (``cache=idata`` without
        # ``match=``) is answered from the variable set the PVS built when that
        # cache was filled, and one such set served 8 of 21 inverters for two
        # days while the array kept producing (2026-09-19 to 2026-09-21). A
        # partial answer is indistinguishable from a smaller array, so it must
        # not be reused.
        path = f"/vars?match={group}&fmt=obj&cache={CACHES[group]}"
        return self._read(path)

    def read_site(self) -> tuple[dict, int]:
        return self.read_group("livedata")

    def read_meters(self) -> tuple[dict, int]:
        return self.read_group("meter")

    def read_inverters(self) -> tuple[dict, int]:
        return self.read_group("inverter")

    def read_health(self) -> tuple[dict, int]:
        """Small uncached query used to spot PVS restarts and rising load."""
        return self._read(HEALTH_PATH, stage="health")

    def read_gateway(self) -> tuple[dict, int]:
        """Focused identity diagnostics; exclude SSID, MAC and other settings."""
        return self._read(GATEWAY_PATH, stage="gateway")


def _build_opener(cookies=None):
    return urllib.request.build_opener(
        # An empty CookieJar is falsy, so ``cookies or CookieJar()`` silently
        # swapped in a jar nobody else held a reference to (2026-09-22: the
        # stale session cookie then survived every re-login and the PVS answered
        # 401 until the process restarted).
        urllib.request.HTTPCookieProcessor(cookies if cookies is not None else http.cookiejar.CookieJar()),
        urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
    )
