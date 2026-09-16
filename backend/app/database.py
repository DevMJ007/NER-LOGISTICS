from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

_IS_VERCEL = os.environ.get("VERCEL", "0") == "1"
_DB_PATH = None if _IS_VERCEL else Path(__file__).resolve().parents[2] / "ner_data.db"
_local = threading.local()


def _conn() -> sqlite3.Connection:
    if not hasattr(_local, "conn") or _local.conn is None:
        if _DB_PATH:
            _local.conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
        else:
            _local.conn = sqlite3.connect(":memory:", check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA foreign_keys=ON")
    return _local.conn


def init_db() -> None:
    conn = _conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS vehicles (
            id TEXT PRIMARY KEY,
            vehicle_number TEXT UNIQUE NOT NULL,
            type TEXT NOT NULL,
            driver_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'available',
            origin TEXT,
            destination TEXT,
            load_type TEXT,
            current_lat REAL DEFAULT 23.727,
            current_lon REAL DEFAULT 92.717,
            speed REAL DEFAULT 0,
            heading REAL DEFAULT 0,
            risk_score INTEGER DEFAULT 0,
            eta TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS vehicle_locations (
            id TEXT PRIMARY KEY,
            vehicle_id TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            speed REAL,
            heading REAL,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS incidents (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            severity TEXT NOT NULL,
            description TEXT,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            photo_url TEXT,
            road_status TEXT DEFAULT 'Unknown',
            corridor TEXT,
            district TEXT,
            reported_by TEXT,
            status TEXT NOT NULL DEFAULT 'REPORTED',
            risk_score INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS field_reports (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            type TEXT NOT NULL,
            description TEXT,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            photo_url TEXT,
            severity TEXT NOT NULL,
            road_status TEXT DEFAULT 'Unknown',
            corridor TEXT,
            district TEXT,
            offline_created INTEGER DEFAULT 0,
            synced_at TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            severity TEXT NOT NULL,
            lat REAL,
            lon REAL,
            target_role TEXT,
            target_district TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT
        );

        CREATE TABLE IF NOT EXISTS fcm_tokens (
            token TEXT PRIMARY KEY,
            role TEXT,
            district TEXT,
            created_at TEXT NOT NULL
        );
    """)
    conn.commit()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def gen_id(prefix: str = "ID") -> str:
    return f"{prefix}-{uuid4().hex[:8].upper()}"


def insert_vehicle(data: dict) -> dict:
    conn = _conn()
    vid = gen_id("VEH")
    ts = now_iso()
    conn.execute(
        """INSERT INTO vehicles (id, vehicle_number, type, driver_name, status, origin, destination,
           load_type, current_lat, current_lon, speed, heading, risk_score, eta, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            vid, data["vehicle_number"], data.get("type", "Truck"), data.get("driver_name", "Unknown"),
            data.get("status", "available"), data.get("origin", ""), data.get("destination", ""),
            data.get("load_type", ""), data.get("current_lat", 23.727), data.get("current_lon", 92.717),
            data.get("speed", 0), data.get("heading", 0), data.get("risk_score", 0),
            data.get("eta", ""), ts,
        ),
    )
    conn.commit()
    return get_vehicle(vid)


def get_vehicle(vid: str) -> dict | None:
    row = _conn().execute("SELECT * FROM vehicles WHERE id=?", (vid,)).fetchone()
    return dict(row) if row else None


def list_vehicles() -> list[dict]:
    rows = _conn().execute("SELECT * FROM vehicles ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


def update_vehicle(vid: str, data: dict) -> dict | None:
    conn = _conn()
    fields = []
    values = []
    for key in ("vehicle_number", "type", "driver_name", "status", "origin", "destination",
                "load_type", "current_lat", "current_lon", "speed", "heading", "risk_score", "eta"):
        if key in data:
            fields.append(f"{key}=?")
            values.append(data[key])
    if not fields:
        return get_vehicle(vid)
    values.append(vid)
    conn.execute(f"UPDATE vehicles SET {', '.join(fields)} WHERE id=?", values)
    conn.commit()
    return get_vehicle(vid)


def delete_vehicle(vid: str) -> bool:
    conn = _conn()
    cur = conn.execute("DELETE FROM vehicles WHERE id=?", (vid,))
    conn.commit()
    return cur.rowcount > 0


def insert_vehicle_location(vid: str, lat: float, lon: float, speed: float = 0, heading: float = 0) -> None:
    conn = _conn()
    loc_id = gen_id("VLOC")
    conn.execute(
        "INSERT INTO vehicle_locations (id, vehicle_id, lat, lon, speed, heading, timestamp) VALUES (?,?,?,?,?,?,?)",
        (loc_id, vid, lat, lon, speed, heading, now_iso()),
    )
    conn.execute("UPDATE vehicles SET current_lat=?, current_lon=?, speed=?, heading=? WHERE id=?",
                 (lat, lon, speed, heading, vid))
    conn.commit()


def insert_incident(data: dict) -> dict:
    conn = _conn()
    iid = gen_id("INC")
    ts = now_iso()
    conn.execute(
        """INSERT INTO incidents (id, type, severity, description, lat, lon, photo_url,
           road_status, corridor, district, reported_by, status, risk_score, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            iid, data["type"], data.get("severity", "Medium"), data.get("description", ""),
            data["lat"], data["lon"], data.get("photo_url"),
            data.get("road_status", "Unknown"), data.get("corridor", ""),
            data.get("district", ""), data.get("reported_by", "anonymous"),
            data.get("status", "REPORTED"), data.get("risk_score", 0), ts, ts,
        ),
    )
    conn.commit()
    return get_incident(iid)


def get_incident(iid: str) -> dict | None:
    row = _conn().execute("SELECT * FROM incidents WHERE id=?", (iid,)).fetchone()
    return dict(row) if row else None


def list_incidents(status: str | None = None) -> list[dict]:
    if status:
        rows = _conn().execute("SELECT * FROM incidents WHERE status=? ORDER BY created_at DESC", (status,)).fetchall()
    else:
        rows = _conn().execute("SELECT * FROM incidents ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


def update_incident_status(iid: str, status: str) -> dict | None:
    conn = _conn()
    ts = now_iso()
    resolved_at = ts if status == "RESOLVED" else None
    conn.execute(
        "UPDATE incidents SET status=?, updated_at=?, resolved_at=COALESCE(?, resolved_at) WHERE id=?",
        (status, ts, resolved_at, iid),
    )
    conn.commit()
    return get_incident(iid)


def insert_field_report(data: dict) -> dict:
    conn = _conn()
    rid = gen_id("RPT")
    ts = now_iso()
    conn.execute(
        """INSERT INTO field_reports (id, user_id, type, description, lat, lon, photo_url,
           severity, road_status, corridor, district, offline_created, synced_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            rid, data.get("user_id"), data["type"], data.get("description", ""),
            data["lat"], data["lon"], data.get("photo_url"),
            data.get("severity", "Medium"), data.get("road_status", "Unknown"),
            data.get("corridor", ""), data.get("district", ""),
            1 if data.get("offline_created") else 0, ts, ts,
        ),
    )
    conn.commit()
    return {"id": rid, "created_at": ts}


def list_field_reports() -> list[dict]:
    rows = _conn().execute("SELECT * FROM field_reports ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


def insert_alert(data: dict) -> dict:
    conn = _conn()
    aid = gen_id("ALT")
    ts = now_iso()
    conn.execute(
        """INSERT INTO alerts (id, type, title, message, severity, lat, lon, target_role, target_district, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            aid, data.get("type", "general"), data["title"], data["message"],
            data.get("severity", "HIGH"), data.get("lat"), data.get("lon"),
            data.get("target_role"), data.get("target_district"), ts,
        ),
    )
    conn.commit()
    return {"id": aid, "created_at": ts}


def register_fcm_token(token: str, role: str = "", district: str = "") -> int:
    conn = _conn()
    conn.execute(
        "INSERT OR REPLACE INTO fcm_tokens (token, role, district, created_at) VALUES (?,?,?,?)",
        (token, role, district, now_iso()),
    )
    conn.commit()
    row = conn.execute("SELECT COUNT(*) as cnt FROM fcm_tokens").fetchone()
    return row["cnt"]


def list_fcm_tokens() -> list[dict]:
    rows = _conn().execute("SELECT * FROM fcm_tokens").fetchall()
    return [dict(r) for r in rows]


def get_active_incidents() -> list[dict]:
    return list_incidents()


def get_blocked_road_count() -> int:
    row = _conn().execute("SELECT COUNT(*) as cnt FROM incidents WHERE road_status='Blocked' AND status != 'RESOLVED'").fetchone()
    return row["cnt"]
