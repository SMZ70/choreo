"""SQLite storage layer for the shared checklist app.

Uses a single connection with WAL mode and a write lock. For a two-user
home LAN app this is rock solid: WAL gives concurrent readers, and the
lock serializes the handful of writes we ever do.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

DB_PATH = Path(os.environ.get("CHECKLIST_DB", Path(__file__).resolve().parent.parent / "data" / "checklist.db"))

_LOCK = threading.RLock()
_CONN: sqlite3.Connection | None = None


def _now() -> float:
    return time.time()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


SCHEMA = """
CREATE TABLE IF NOT EXISTS lists (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    emoji      TEXT NOT NULL DEFAULT '📝',
    color      TEXT NOT NULL DEFAULT 'indigo',
    kind       TEXT NOT NULL DEFAULT 'generic',
    position   REAL NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
    id         TEXT PRIMARY KEY,
    list_id    TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    done       INTEGER NOT NULL DEFAULT 0,
    position   REAL NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT '',
    done_by    TEXT NOT NULL DEFAULT '',
    assignee   TEXT NOT NULL DEFAULT '',
    qty        INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL,
    done_at    REAL
);

CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id);
"""


def connect() -> sqlite3.Connection:
    global _CONN
    if _CONN is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.commit()
        _CONN = conn
    return _CONN


def _migrate(conn: sqlite3.Connection) -> None:
    """Additive, idempotent migrations for existing databases."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(items)").fetchall()}
    if "assignee" not in cols:
        conn.execute("ALTER TABLE items ADD COLUMN assignee TEXT NOT NULL DEFAULT ''")
    if "qty" not in cols:
        conn.execute("ALTER TABLE items ADD COLUMN qty INTEGER NOT NULL DEFAULT 1")


def init() -> None:
    with _LOCK:
        conn = connect()
        # Seed with a friendly example only if completely empty.
        count = conn.execute("SELECT COUNT(*) AS c FROM lists").fetchone()["c"]
        if count == 0:
            _seed(conn)


def _seed(conn: sqlite3.Connection) -> None:
    now = _now()
    chores = new_id()
    shopping = new_id()
    conn.execute(
        "INSERT INTO lists(id,name,emoji,color,kind,position,created_at) VALUES(?,?,?,?,?,?,?)",
        (chores, "House chores", "🏠", "emerald", "tasks", 0, now),
    )
    conn.execute(
        "INSERT INTO lists(id,name,emoji,color,kind,position,created_at) VALUES(?,?,?,?,?,?,?)",
        (shopping, "Shopping", "🛒", "indigo", "shopping", 1, now),
    )
    starter = [
        (chores, "Water the plants", 0),
        (chores, "Take out recycling", 1),
        (shopping, "Milk", 0),
        (shopping, "Coffee beans", 1),
    ]
    for list_id, text, pos in starter:
        conn.execute(
            "INSERT INTO items(id,list_id,text,position,created_at) VALUES(?,?,?,?,?)",
            (new_id(), list_id, text, pos, now),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

def get_state() -> dict[str, Any]:
    with _LOCK:
        conn = connect()
        lists = [dict(r) for r in conn.execute(
            "SELECT * FROM lists WHERE archived=0 ORDER BY position, created_at"
        ).fetchall()]
        items = [dict(r) for r in conn.execute(
            "SELECT i.* FROM items i JOIN lists l ON l.id=i.list_id "
            "WHERE l.archived=0 ORDER BY i.position, i.created_at"
        ).fetchall()]
    by_list: dict[str, list] = {l["id"]: [] for l in lists}
    for it in items:
        it["done"] = bool(it["done"])
        by_list.setdefault(it["list_id"], []).append(it)
    for l in lists:
        l["items"] = by_list.get(l["id"], [])
    return {"lists": lists}


# ---------------------------------------------------------------------------
# List mutations
# ---------------------------------------------------------------------------

def create_list(name: str, emoji: str, color: str, kind: str) -> str:
    with _LOCK:
        conn = connect()
        pos = conn.execute("SELECT COALESCE(MAX(position),-1)+1 AS p FROM lists WHERE archived=0").fetchone()["p"]
        lid = new_id()
        conn.execute(
            "INSERT INTO lists(id,name,emoji,color,kind,position,created_at) VALUES(?,?,?,?,?,?,?)",
            (lid, name, emoji, color, kind, pos, _now()),
        )
        conn.commit()
        return lid


def update_list(list_id: str, fields: dict[str, Any]) -> None:
    allowed = {"name", "emoji", "color", "kind", "position", "archived"}
    sets = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not sets:
        return
    with _LOCK:
        conn = connect()
        cols = ", ".join(f"{k}=?" for k in sets)
        conn.execute(f"UPDATE lists SET {cols} WHERE id=?", (*sets.values(), list_id))
        conn.commit()


def delete_list(list_id: str) -> None:
    with _LOCK:
        conn = connect()
        conn.execute("DELETE FROM lists WHERE id=?", (list_id,))
        conn.commit()


def reorder_lists(order: list[str]) -> None:
    with _LOCK:
        conn = connect()
        for pos, lid in enumerate(order):
            conn.execute("UPDATE lists SET position=? WHERE id=?", (pos, lid))
        conn.commit()


# ---------------------------------------------------------------------------
# Item mutations
# ---------------------------------------------------------------------------

def create_item(list_id: str, text: str, note: str, by: str, assignee: str = "", qty: int = 1) -> str | None:
    with _LOCK:
        conn = connect()
        exists = conn.execute("SELECT 1 FROM lists WHERE id=?", (list_id,)).fetchone()
        if not exists:
            return None
        pos = conn.execute(
            "SELECT COALESCE(MAX(position),-1)+1 AS p FROM items WHERE list_id=?", (list_id,)
        ).fetchone()["p"]
        iid = new_id()
        conn.execute(
            "INSERT INTO items(id,list_id,text,note,position,created_by,assignee,qty,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (iid, list_id, text, note, pos, by, assignee, max(1, int(qty)), _now()),
        )
        conn.commit()
        return iid


def update_item(item_id: str, fields: dict[str, Any], by: str) -> None:
    with _LOCK:
        conn = connect()
        row = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        if not row:
            return
        sets: dict[str, Any] = {}
        if "text" in fields and fields["text"] is not None:
            sets["text"] = fields["text"]
        if "note" in fields and fields["note"] is not None:
            sets["note"] = fields["note"]
        if "assignee" in fields and fields["assignee"] is not None:
            sets["assignee"] = fields["assignee"]
        if "qty" in fields and fields["qty"] is not None:
            sets["qty"] = max(1, int(fields["qty"]))
        if "position" in fields and fields["position"] is not None:
            sets["position"] = fields["position"]
        if "done" in fields and fields["done"] is not None:
            done = 1 if fields["done"] else 0
            sets["done"] = done
            sets["done_by"] = by if done else ""
            sets["done_at"] = _now() if done else None
        if not sets:
            return
        cols = ", ".join(f"{k}=?" for k in sets)
        conn.execute(f"UPDATE items SET {cols} WHERE id=?", (*sets.values(), item_id))
        conn.commit()


def delete_item(item_id: str) -> None:
    with _LOCK:
        conn = connect()
        conn.execute("DELETE FROM items WHERE id=?", (item_id,))
        conn.commit()


def clear_completed(list_id: str) -> int:
    with _LOCK:
        conn = connect()
        cur = conn.execute("DELETE FROM items WHERE list_id=? AND done=1", (list_id,))
        conn.commit()
        return cur.rowcount


def reorder_items(list_id: str, order: list[str]) -> None:
    with _LOCK:
        conn = connect()
        for pos, iid in enumerate(order):
            conn.execute("UPDATE items SET position=? WHERE id=? AND list_id=?", (pos, iid, list_id))
        conn.commit()
