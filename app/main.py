"""Shared Checklist — FastAPI backend with live WebSocket sync.

Design goals: robust, dependency-light, no build step. The frontend is
plain static files; every mutation broadcasts the full (tiny) state to all
connected browsers so clients never drift out of sync.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="Shared Checklist")


@app.middleware("http")
async def method_override(request, call_next):
    """Allow PATCH/DELETE to be tunnelled over POST via a header.

    Some reverse proxies only permit GET/HEAD/POST. The frontend sends those
    verbs as POST + `X-HTTP-Method-Override`, which we translate back here so
    the same code works directly and behind a restrictive proxy.
    """
    if request.method == "POST":
        ovr = request.headers.get("x-http-method-override", "").upper()
        if ovr in ("PATCH", "DELETE", "PUT"):
            request.scope["method"] = ovr
    return await call_next(request)


# ---------------------------------------------------------------------------
# WebSocket hub
# ---------------------------------------------------------------------------

class Hub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def join(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def leave(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        msg = json.dumps(payload)
        async with self._lock:
            dead = []
            for ws in self._clients:
                try:
                    await ws.send_text(msg)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self._clients.discard(ws)


hub = Hub()


async def push_state() -> None:
    await hub.broadcast({"type": "state", "data": db.get_state()})


@app.on_event("startup")
def _startup() -> None:
    db.init()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class ListCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    emoji: str = Field(default="📝", max_length=8)
    color: str = Field(default="indigo", max_length=20)
    kind: str = Field(default="generic", max_length=20)


class ListPatch(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    emoji: str | None = Field(default=None, max_length=8)
    color: str | None = Field(default=None, max_length=20)
    kind: str | None = Field(default=None, max_length=20)
    archived: int | None = None


class ItemCreate(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    note: str = Field(default="", max_length=2000)
    by: str = Field(default="", max_length=40)
    assignee: str = Field(default="", max_length=40)
    qty: int = Field(default=1, ge=1, le=9999)


class ItemPatch(BaseModel):
    text: str | None = Field(default=None, max_length=500)
    note: str | None = Field(default=None, max_length=2000)
    done: bool | None = None
    position: float | None = None
    assignee: str | None = Field(default=None, max_length=40)
    qty: int | None = Field(default=None, ge=1, le=9999)
    by: str = Field(default="", max_length=40)


class Order(BaseModel):
    order: list[str]


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.get("/api/state")
def api_state() -> dict:
    return db.get_state()


@app.post("/api/lists")
async def api_create_list(body: ListCreate) -> dict:
    lid = db.create_list(body.name.strip(), body.emoji, body.color, body.kind)
    await push_state()
    return {"id": lid}


@app.patch("/api/lists/{list_id}")
async def api_patch_list(list_id: str, body: ListPatch) -> dict:
    db.update_list(list_id, body.model_dump(exclude_none=True))
    await push_state()
    return {"ok": True}


@app.delete("/api/lists/{list_id}")
async def api_delete_list(list_id: str) -> dict:
    db.delete_list(list_id)
    await push_state()
    return {"ok": True}


@app.post("/api/lists/reorder")
async def api_reorder_lists(body: Order) -> dict:
    db.reorder_lists(body.order)
    await push_state()
    return {"ok": True}


@app.post("/api/lists/{list_id}/items")
async def api_create_item(list_id: str, body: ItemCreate) -> dict:
    iid = db.create_item(list_id, body.text.strip(), body.note.strip(), body.by, body.assignee, body.qty)
    if iid is None:
        return JSONResponse({"error": "list not found"}, status_code=404)
    await push_state()
    return {"id": iid}


@app.patch("/api/items/{item_id}")
async def api_patch_item(item_id: str, body: ItemPatch) -> dict:
    db.update_item(item_id, body.model_dump(exclude={"by"}, exclude_none=True), body.by)
    await push_state()
    return {"ok": True}


@app.delete("/api/items/{item_id}")
async def api_delete_item(item_id: str) -> dict:
    db.delete_item(item_id)
    await push_state()
    return {"ok": True}


@app.post("/api/lists/{list_id}/clear-completed")
async def api_clear_completed(list_id: str) -> dict:
    n = db.clear_completed(list_id)
    await push_state()
    return {"cleared": n}


@app.post("/api/lists/{list_id}/items/reorder")
async def api_reorder_items(list_id: str, body: Order) -> dict:
    db.reorder_items(list_id, body.order)
    await push_state()
    return {"ok": True}


@app.get("/api/health")
def api_health() -> dict:
    return {"ok": True}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await hub.join(ws)
    try:
        # Send current state immediately on connect.
        await ws.send_text(json.dumps({"type": "state", "data": db.get_state()}))
        while True:
            # We don't need inbound messages; keep the socket alive and
            # drain pings/keepalives so disconnects are detected.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await hub.leave(ws)


# ---------------------------------------------------------------------------
# Static frontend (mounted last so /api and /ws win)
# ---------------------------------------------------------------------------

@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
