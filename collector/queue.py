"""SQLite pending-upload queue and Pi-side anonymous panel mapping.

Commit locally before upload, delete only after cloud acknowledgment. The
database holds normalized, allowlisted records only. WAL with ``synchronous``
FULL keeps a committed minute recoverable after a power loss; at ~1,440
commits/day the durability cost is irrelevant.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

from .model import to_iso, utc_now

SCHEMA = """
CREATE TABLE IF NOT EXISTS pending (
  record_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  captured_at_utc TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS pending_state_idx ON pending (state, created_at_utc);
-- Identity is the device serial, not the inverter index: the PVS renumbers its
-- indexes when it restarts (2026-09-21: every index pointed at a different
-- physical panel), while the serial stays with the hardware. The serial is
-- local only; the cloud sees the panel_id.
CREATE TABLE IF NOT EXISTS panel_map (
  panel_id TEXT PRIMARY KEY,
  serial TEXT UNIQUE,
  inverter_index TEXT,
  last_measured_at_utc TEXT,
  last_sample_slot_utc TEXT
);
"""

_CAPTURED_FIELDS = ("window_start_utc", "slot_ts", "event_ts_utc")


class PendingQueue:
    """One writer (the collector process) over one SQLite file."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.executescript(SCHEMA)
        self._migrate_panel_map()

    def _migrate_panel_map(self) -> None:
        """Move a pre-serial panel_map to the serial-keyed shape, keeping ids."""
        columns = {row[1] for row in self.connection.execute("PRAGMA table_info(panel_map)")}
        if "serial" in columns:
            if "last_sample_slot_utc" not in columns:
                self.connection.execute("ALTER TABLE panel_map ADD COLUMN last_sample_slot_utc TEXT")
            return
        # The old table is keyed by inverter_index; the next inverter read binds
        # each row's serial, so an existing installation keeps every panel id.
        with self.connection:
            self.connection.execute("ALTER TABLE panel_map RENAME TO panel_map_index_keyed")
            self.connection.execute(
                "CREATE TABLE panel_map (panel_id TEXT PRIMARY KEY, serial TEXT UNIQUE,"
                " inverter_index TEXT, last_measured_at_utc TEXT, last_sample_slot_utc TEXT)"
            )
            self.connection.execute(
                "INSERT INTO panel_map (panel_id, serial, inverter_index, last_measured_at_utc)"
                " SELECT panel_id, NULL, inverter_index, last_measured_at_utc FROM panel_map_index_keyed"
            )
            self.connection.execute("DROP TABLE panel_map_index_keyed")

    def close(self) -> None:
        self.connection.close()

    def enqueue(self, records: list[dict]) -> int:
        """Insert records, ignoring ones already queued under the same ID."""
        created_at = to_iso(utc_now())
        inserted = 0
        with self.connection:
            for record in records:
                captured = next((record[field] for field in _CAPTURED_FIELDS if record.get(field)), created_at)
                cursor = self.connection.execute(
                    "INSERT OR IGNORE INTO pending"
                    " (record_id, kind, captured_at_utc, payload_json, created_at_utc)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (
                        record["record_id"],
                        record.get("kind", "unknown"),
                        captured,
                        json.dumps(record, separators=(",", ":"), sort_keys=True),
                        created_at,
                    ),
                )
                inserted += cursor.rowcount
                if cursor.rowcount and record.get("kind") == "panel_sample":
                    self.connection.execute(
                        "UPDATE panel_map SET last_measured_at_utc = ?, last_sample_slot_utc = ? WHERE panel_id = ?",
                        (record["measured_at_utc"], record["slot_ts"], record["panel_id"]),
                    )
        return inserted

    def batch(self, limit: int = 100) -> list[dict]:
        """Oldest pending records first, with their stored payload unchanged."""
        rows = self.connection.execute(
            "SELECT record_id, kind, payload_json, attempts FROM pending"
            " WHERE state = 'pending' ORDER BY rowid LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {"record_id": row[0], "kind": row[1], "payload": json.loads(row[2]), "attempts": row[3]}
            for row in rows
        ]

    def ack(self, record_ids: list[str]) -> int:
        if not record_ids:
            return 0
        with self.connection:
            cursor = self.connection.executemany("DELETE FROM pending WHERE record_id = ?", [(rid,) for rid in record_ids])
        return cursor.rowcount

    def bump(self, record_ids: list[str]) -> None:
        if not record_ids:
            return
        with self.connection:
            self.connection.executemany(
                "UPDATE pending SET attempts = attempts + 1 WHERE record_id = ?", [(rid,) for rid in record_ids]
            )

    def fail(self, record_ids: list[str], reason: str) -> None:
        """Isolate records the cloud rejected so the queue can move on."""
        if not record_ids:
            return
        with self.connection:
            self.connection.executemany(
                "UPDATE pending SET state = 'failed', last_error = ? WHERE record_id = ?",
                [(reason[:200], rid) for rid in record_ids],
            )

    def counts(self) -> dict:
        rows = dict(self.connection.execute("SELECT state, COUNT(*) FROM pending GROUP BY state").fetchall())
        oldest = self.connection.execute("SELECT MIN(created_at_utc) FROM pending WHERE state = 'pending'").fetchone()[0]
        return {"pending": rows.get("pending", 0), "failed": rows.get("failed", 0), "oldest_pending_utc": oldest}

    def bytes_on_disk(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.path) + suffix)
            if candidate.exists():
                total += candidate.stat().st_size
        return total

    def free_bytes(self) -> int:
        return shutil.disk_usage(self.path).free

    def panel_id(self, inverter_index: str, serial: str | None = None) -> str:
        """Stable, serial-free panel ID for one inverter.

        The serial decides identity, and the index is only a hint: it is what the
        PVS renumbers when it restarts, and following it silently relabels every
        panel in the array.
        """
        if serial is not None:
            row = self.connection.execute("SELECT panel_id FROM panel_map WHERE serial = ?", (serial,)).fetchone()
            if row:
                self._bind_index(row[0], inverter_index)
                return row[0]
        row = self.connection.execute(
            "SELECT panel_id, serial FROM panel_map WHERE inverter_index = ? ORDER BY serial IS NULL DESC",
            (inverter_index,),
        ).fetchone()
        if row and (serial is None or row[1] is None or row[1] == serial):
            if serial is not None and row[1] is None:
                # First read after the upgrade: this index's existing panel id is
                # the one its history already uses, so bind the serial to it.
                with self.connection:
                    self.connection.execute("UPDATE panel_map SET serial = ? WHERE panel_id = ?", (serial, row[0]))
            self._bind_index(row[0], inverter_index)
            return row[0]
        with self.connection:
            highest = self.connection.execute(
                "SELECT COALESCE(MAX(CAST(SUBSTR(panel_id, 2) AS INTEGER)), 0) FROM panel_map"
            ).fetchone()[0]
            panel_id = f"p{highest + 1:02d}"
            self.connection.execute(
                "INSERT INTO panel_map (panel_id, serial, inverter_index) VALUES (?, ?, ?)",
                (panel_id, serial, inverter_index),
            )
        return panel_id

    def _bind_index(self, panel_id: str, inverter_index: str) -> None:
        """Keep one row per index, so the index fallback never reads a stale one."""
        with self.connection:
            self.connection.execute(
                "UPDATE panel_map SET inverter_index = NULL WHERE inverter_index = ? AND panel_id != ?",
                (inverter_index, panel_id),
            )
            self.connection.execute(
                "UPDATE panel_map SET inverter_index = ? WHERE panel_id = ?", (inverter_index, panel_id)
            )

    def panel_last_measured(self, panel_id: str) -> str | None:
        row = self.connection.execute(
            "SELECT last_measured_at_utc FROM panel_map WHERE panel_id = ?", (panel_id,)
        ).fetchone()
        return row[0] if row else None

    def panel_last_sample_slot(self, panel_id: str) -> str | None:
        row = self.connection.execute(
            "SELECT last_sample_slot_utc FROM panel_map WHERE panel_id = ?", (panel_id,)
        ).fetchone()
        return row[0] if row else None

    def panel_indexes(self) -> dict[str, str]:
        """Last known inverter index per panel, so a renumbering is visible."""
        return {
            row[0]: row[1]
            for row in self.connection.execute(
                "SELECT panel_id, inverter_index FROM panel_map WHERE inverter_index IS NOT NULL"
            )
        }

    def panel_count(self) -> int:
        return self.connection.execute("SELECT COUNT(*) FROM panel_map").fetchone()[0]
