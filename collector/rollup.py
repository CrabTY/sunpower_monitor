"""Minute and five-minute rollups with explicit coverage and quality.

Rules from the architecture document: only fresh-by-measurement-time samples
enter a mean; equal power with an advancing measurement time is a new
measurement; an unchanged measurement time is not restamped as new.
"""

from __future__ import annotations

from datetime import datetime

from .model import (
    QUALITY_CLOCK_INVALID,
    QUALITY_OK,
    QUALITY_PARTIAL,
    QUALITY_SOURCE_ERROR,
    QUALITY_STALE_SOURCE,
    SCHEMA_VERSION,
    PanelSample,
    SiteSample,
    floor_minute,
    record_id,
    to_iso,
)

PANEL_SLOT_SECONDS = 300
MIN_SAMPLES_COMPLETE = 4
MAX_GAP_SECONDS = 30.0
SITE_POWER_FIELDS = ("pv_kw", "load_kw_reported", "grid_kw")
SITE_MEAN_FIELDS = SITE_POWER_FIELDS + ("battery_kw",)
SITE_END_FIELDS = ("pv_kwh_total", "load_kwh_total_reported", "grid_net_kwh_total")


class SiteMinute:
    """Accumulates the site samples that belong to one UTC minute."""

    def __init__(self, window_start: datetime):
        self.window_start = window_start
        self.sample_count = 0
        self.repeated_count = 0
        self.invalid_count = 0
        self.out_of_window_count = 0
        self.samples: list[SiteSample] = []
        self._last_measured: datetime | None = None

    def add(self, sample: SiteSample) -> bool:
        """Only samples measured inside this UTC minute enter the mean."""
        self.sample_count += 1
        if sample.measured_at is None:
            self.invalid_count += 1
            return False
        if floor_minute(sample.measured_at) != self.window_start:
            self.out_of_window_count += 1
            return False
        if self._last_measured is not None and sample.measured_at <= self._last_measured:
            self.repeated_count += 1
            return False
        self._last_measured = sample.measured_at
        self.samples.append(sample)
        return True

    def record(self, collector_id: str, window_end: datetime, failure: str | None = None) -> dict:
        means: dict[str, float | None] = {}
        counts: dict[str, int] = {}
        for name in SITE_MEAN_FIELDS:
            values = [sample.values[name] for sample in self.samples if sample.values.get(name) is not None]
            counts[name] = len(values)
            means[name] = round(sum(values) / len(values), 4) if values else None
        last = self.samples[-1] if self.samples else None
        gaps = [
            (current.measured_at - previous.measured_at).total_seconds()
            for previous, current in zip(self.samples, self.samples[1:])
        ]
        if self.sample_count == 0:
            quality = QUALITY_SOURCE_ERROR
        elif not self.samples:
            quality = QUALITY_CLOCK_INVALID
        elif (
            len(self.samples) >= MIN_SAMPLES_COMPLETE
            and max(gaps, default=0.0) <= MAX_GAP_SECONDS
            and all(counts[name] for name in SITE_POWER_FIELDS)
        ):
            quality = QUALITY_OK
        else:
            quality = QUALITY_PARTIAL
        key = to_iso(self.window_start)
        return {
            "schema_version": SCHEMA_VERSION,
            "collector_id": collector_id,
            "record_id": record_id(collector_id, "site_minute", key),
            "kind": "site_minute",
            "window_start_utc": key,
            "window_end_utc": to_iso(window_end),
            "sample_count": self.sample_count,
            "valid_count": len(self.samples),
            "repeated_count": self.repeated_count,
            "invalid_count": self.invalid_count,
            "out_of_window_count": self.out_of_window_count,
            "complete": quality == QUALITY_OK,
            "quality": quality,
            "pv_kw_avg": means["pv_kw"],
            "load_kw_reported_avg": means["load_kw_reported"],
            "grid_kw_avg": means["grid_kw"],
            "battery_kw_avg": means["battery_kw"],
            # ``error`` names the group and exception when a read failed inside
            # this window; the column is free-form JSON, so no schema change.
            "valid_counts": {**counts, **({"error": failure} if failure else {})},
            "pv_kwh_total_end": last.values.get("pv_kwh_total") if last else None,
            "load_kwh_total_reported_end": last.values.get("load_kwh_total_reported") if last else None,
            "grid_net_kwh_total_end": last.values.get("grid_net_kwh_total") if last else None,
            "last_measured_at_utc": to_iso(last.measured_at) if last else None,
        }


def panel_entry(sample: PanelSample, fresh: bool, last_valid_measured_at: str | None) -> dict:
    """One panel's state for a five-minute slot."""
    measured_at = to_iso(sample.measured_at) if fresh else None
    return {
        "quality": QUALITY_OK if fresh else QUALITY_STALE_SOURCE,
        "ac_kw": sample.values.get("ac_kw") if fresh else None,
        "energy_kwh_total": sample.values.get("energy_kwh_total") if fresh else None,
        # Inverter diagnostics: stored with the sample, never backfilled, so a
        # night sample or an unreadable field stays null instead of guessed.
        "dc_kw": sample.values.get("dc_kw") if fresh else None,
        "dc_v": sample.values.get("dc_v") if fresh else None,
        "dc_a": sample.values.get("dc_a") if fresh else None,
        "ac_v": sample.values.get("ac_v") if fresh else None,
        "ac_a": sample.values.get("ac_a") if fresh else None,
        "heatsink_c": sample.values.get("heatsink_c") if fresh else None,
        "measured_at_utc": measured_at,
        "last_valid_measured_at_utc": measured_at or last_valid_measured_at,
    }


def panel_sample_record(collector_id: str, panel_id: str, slot_start: datetime, entry: dict) -> dict:
    slot_ts = to_iso(slot_start)
    return {
        "schema_version": SCHEMA_VERSION,
        "collector_id": collector_id,
        "record_id": record_id(collector_id, "panel_sample", f"{slot_ts}:{panel_id}"),
        "kind": "panel_sample",
        "panel_id": panel_id,
        "slot_ts": slot_ts,
        **entry,
    }


if __name__ == "__main__":
    from datetime import timedelta, timezone

    start = datetime(2026, 9, 18, 2, 0, tzinfo=timezone.utc)
    minute = SiteMinute(start)
    for second in range(0, 60, 10):
        minute.add(
            SiteSample(
                collected_at=start,
                measured_at=start + timedelta(seconds=second),
                values={"pv_kw": 3.0, "load_kw_reported": 1.2, "grid_kw": -1.8, "battery_kw": None},
            )
        )
    record = minute.record("home-pvs", start + timedelta(minutes=1))
    assert record["quality"] == QUALITY_OK and record["sample_count"] == 6
    assert record["pv_kw_avg"] == 3.0 and record["battery_kw_avg"] is None
    empty = SiteMinute(start).record("home-pvs", start)
    assert empty["quality"] == QUALITY_SOURCE_ERROR and empty["pv_kw_avg"] is None
    print("rollup self-check passed")
