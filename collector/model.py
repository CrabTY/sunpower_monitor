"""Normalized PVS6 readings: allowlisted parsing, units, and quality.

A parser takes the flat ``{path: value}`` dictionary returned by a focused
varserver query and emits normalized fields. Raw path dictionaries stay in
memory and are never persisted. Missing or malformed values become ``None``,
never ``0``.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone

SCHEMA_VERSION = 1

QUALITY_OK = "ok"
QUALITY_PARTIAL = "partial"
QUALITY_SOURCE_ERROR = "source_error"
QUALITY_STALE_SOURCE = "stale_source"
QUALITY_CLOCK_INVALID = "clock_invalid"
QUALITY_OFFLINE = "offline"

# Allowlist: normalized name -> varserver path. Nothing outside this map is read.
SITE_FIELDS = {
    "pv_kw": "pv_p",
    "pv_kwh_total": "pv_en",
    "load_kw_reported": "site_load_p",
    "load_kwh_total_reported": "site_load_en",
    "grid_kw": "net_p",
    "grid_net_kwh_total": "net_en",
    "battery_kw": "ess_p",
}
SITE_TIME_FIELD = "time"
PANEL_FIELDS = {
    "ac_kw": "p3phsumKw",
    "energy_kwh_total": "ltea3phsumKwh",
    "dc_kw": "pMppt1Kw",
    "dc_v": "vMppt1V",
    "dc_a": "iMppt1A",
    "ac_v": "vln3phavgV",
    "ac_a": "i3phsumA",
    "heatsink_c": "tHtsnkDegc",
}
METER_FIELDS = {
    "kw": "p3phsumKw",
    "pos_kwh_total": "posLtea3phsumKwh",
    "neg_kwh_total": "negLtea3phsumKwh",
}
MEASUREMENT_TIME_FIELD = "msmtEps"

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_EPOCH_MS_THRESHOLD = 1e11
_MISSING_TEXT = {"", "none", "null", "nan", "n/a", "-"}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def floor_minute(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(second=0, microsecond=0)


def floor_slot(value: datetime, seconds: int = 300) -> datetime:
    epoch_seconds = int(value.timestamp())
    return datetime.fromtimestamp(epoch_seconds - epoch_seconds % seconds, timezone.utc)


def record_id(collector_id: str, kind: str, key: str) -> str:
    """Deterministic record ID; replay keeps the same ID and content."""
    return f"{collector_id}:{kind}:{key}"


def finite_number(value: object) -> float | None:
    """Return a finite float, or None for missing/blank/NaN/inf/malformed input."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        text = value.strip()
        if text.lower() in _MISSING_TEXT:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    elif isinstance(value, (int, float)):
        number = float(value)
    else:
        return None
    return number if math.isfinite(number) else None


def parse_serial(value: object) -> str | None:
    """A device serial, or None when the device did not report one."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or text.lower() in _MISSING_TEXT:
        return None
    return text


def parse_measured_time(value: object) -> datetime | None:
    """Parse a PVS measurement timestamp: epoch seconds, epoch milliseconds, or ISO."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _from_epoch(float(value))
    text = str(value).strip()
    if not text or text.lower() in _MISSING_TEXT:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return _from_epoch(float(text))
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _from_epoch(value: float) -> datetime | None:
    if not math.isfinite(value):
        return None
    if abs(value) > _EPOCH_MS_THRESHOLD:
        value = value / 1000.0
    try:
        return datetime.fromtimestamp(value, timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _livedata_fields(data: dict, fields: dict[str, str]) -> dict[str, object]:
    return {name: data.get(f"/sys/livedata/{path}") for name, path in fields.items()}


def device_fields(data: dict, group: str, fields: dict[str, str]) -> dict[str, dict]:
    """Allowlisted ``{device_index: {field: raw}}`` from a flat path dictionary."""
    found: dict[str, dict] = {}
    for path, value in data.items():
        if not isinstance(path, str):
            continue
        parts = path.split("/")
        if len(parts) != 6 or parts[1] != "sys" or parts[2] != "devices" or parts[3] != group:
            continue
        for name, field in fields.items():
            if parts[5] == field:
                found.setdefault(parts[4], {})[name] = value
                break
    return found


def _index_key(index: str) -> tuple[int, int | str]:
    return (0, int(index)) if index.isdigit() else (1, index)


@dataclass(frozen=True)
class SiteSample:
    collected_at: datetime
    measured_at: datetime | None
    values: dict[str, float | None]
    field_count: int = 0

    @property
    def quality(self) -> str:
        if self.measured_at is None:
            return QUALITY_CLOCK_INVALID
        if any(self.values.get(name) is None for name in ("pv_kw", "load_kw_reported", "grid_kw")):
            return QUALITY_PARTIAL
        return QUALITY_OK


@dataclass(frozen=True)
class PanelSample:
    index: str
    measured_at: datetime | None
    values: dict[str, float | None]
    # The device's own serial, used only to keep this panel's identity across a
    # PVS restart. It never enters a stored record: see parse_panels.
    serial: str | None = None


@dataclass(frozen=True)
class MeterSample:
    index: str
    measured_at: datetime | None
    values: dict[str, float | None]


def parse_site(data: dict, collected_at: datetime | None = None) -> SiteSample:
    """Normalize one ``livedata`` group response."""
    raw = _livedata_fields(data, SITE_FIELDS)
    return SiteSample(
        collected_at=collected_at or utc_now(),
        measured_at=parse_measured_time(data.get(f"/sys/livedata/{SITE_TIME_FIELD}")),
        values={name: finite_number(value) for name, value in raw.items()},
        field_count=len(data),
    )


def parse_panels(data: dict) -> list[PanelSample]:
    """Normalize every inverter the response actually contains.

    The serial is read here and kept on the sample, never in ``values``: the
    cloud receives the anonymous ``pNN`` its collector assigns, and the serial
    stays on the Pi (see docs/architecture.md).
    """
    fields = {**PANEL_FIELDS, "measured_at": MEASUREMENT_TIME_FIELD}
    devices = device_fields(data, "inverter", fields)
    serials = device_fields(data, "inverter", {"serial": "sn"})
    panels = []
    for index in sorted(devices, key=_index_key):
        raw = devices[index]
        panels.append(
            PanelSample(
                index=index,
                measured_at=parse_measured_time(raw.get("measured_at")),
                values={name: finite_number(raw.get(name)) for name in PANEL_FIELDS},
                serial=parse_serial(serials.get(index, {}).get("serial")),
            )
        )
    return panels


def parse_meters(data: dict) -> list[MeterSample]:
    """Normalize every meter device in the response; device roles stay unverified."""
    fields = {**METER_FIELDS, "measured_at": MEASUREMENT_TIME_FIELD}
    devices = device_fields(data, "meter", fields)
    meters = []
    for index in sorted(devices, key=_index_key):
        raw = devices[index]
        meters.append(
            MeterSample(
                index=index,
                measured_at=parse_measured_time(raw.get("measured_at")),
                values={name: finite_number(raw.get(name)) for name in METER_FIELDS},
            )
        )
    return meters


def live_payload(collector_id: str, sample: SiteSample) -> dict:
    """One ``site_latest`` snapshot for the discardable live path."""
    payload = {
        "schema_version": SCHEMA_VERSION,
        "collector_id": collector_id,
        "collected_at_utc": to_iso(sample.collected_at),
        "measured_at_utc": to_iso(sample.measured_at),
        "quality": sample.quality,
    }
    payload.update(sample.values)
    return payload


def pvs_uptime_regressed(previous: dict, current: dict) -> bool:
    """A decreasing uptime means the PVS restarted; missing values prove nothing."""
    before, after = previous.get("uptime"), current.get("uptime")
    return before is not None and after is not None and after < before


if __name__ == "__main__":
    # Smallest runnable check for the parsing rules that carry real risk.
    assert finite_number("1.5") == 1.5
    assert finite_number(float("nan")) is None and finite_number("") is None
    assert finite_number(0) == 0.0 and finite_number(False) is None
    assert parse_measured_time(1758160800) == datetime.fromtimestamp(1758160800, timezone.utc)
    assert parse_measured_time("1758160800000") == datetime.fromtimestamp(1758160800, timezone.utc)
    assert parse_measured_time("2026-09-18T02:00:00Z") == datetime(2026, 9, 18, 2, 0, tzinfo=timezone.utc)
    assert parse_measured_time("not-a-time") is None
    sample = parse_site(
        {
            "/sys/livedata/pv_p": "3.0",
            "/sys/livedata/site_load_p": 1.2,
            "/sys/livedata/net_p": -1.8,
            "/sys/livedata/time": "2026-09-18T02:00:00Z",
        },
        datetime(2026, 9, 18, 2, 0, 1, tzinfo=timezone.utc),
    )
    assert sample.values["pv_kw"] == 3.0 and sample.values["grid_kw"] == -1.8
    assert sample.values["battery_kw"] is None and sample.quality == QUALITY_OK
    panels = parse_panels(
        {
            "/sys/devices/inverter/2/p3phsumKw": 0.4,
            "/sys/devices/inverter/2/pMppt1Kw": 0.45,
            "/sys/devices/inverter/2/msmtEps": 1758160800,
            "/sys/devices/inverter/2/serialnum": "must-not-be-read",
        }
    )
    assert len(panels) == 2 - 1 and panels[0].values["ac_kw"] == 0.4
    assert panels[0].values["dc_kw"] == 0.45 and "serialnum" not in panels[0].values
    print("model self-check passed")
