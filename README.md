# Choreo

A small, self-hosted checklist app for a couple or a household. Make lists,
tick things off, and everyone sees changes instantly from their phone or
laptop. No accounts, no cloud, no build step.

It grew out of wanting one shared place for chores and the grocery run without
installing yet another app with a login.

## What it does

- Multiple lists, each with its own icon, color, and type
- Three list types that change how the list behaves:
  - **Tasks**: assign items to people, filter by who, see who finished what
  - **Shopping**: quantities per item, plus a one-tap "shopping mode" for the store
  - **General**: just a plain checklist
- Live sync across every open browser (WebSocket)
- Drag to reorder, inline edit, clear completed
- Completed items drop into their own collapsible section
- Works with mixed right-to-left and left-to-right text
- Installable as a PWA, responsive, automatic light and dark themes

Identity is a name you pick on first visit, stored in your browser. It is used
only to label who added or did something. Good enough for a home network; add
real auth if you expose it to the internet.

## Stack

Python (FastAPI + Uvicorn) and SQLite on the backend. Plain HTML, CSS, and
JavaScript on the frontend. No framework, no bundler.

## Run it

```bash
uv sync
uv run uvicorn app.main:app --host 0.0.0.0 --port 8077
```

Then open `http://localhost:8077` (or the host's LAN address) in any browser.

Without uv:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install "fastapi" "uvicorn[standard]"
uvicorn app.main:app --host 0.0.0.0 --port 8077
```

The database is created on first run at `data/checklist.db`. Point it elsewhere
with the `CHECKLIST_DB` environment variable.

## Behind a reverse proxy

The frontend works under any sub-path, and it tunnels PATCH and DELETE over POST
via an `X-HTTP-Method-Override` header, so it runs fine behind proxies that only
allow GET, HEAD, and POST. Just forward the WebSocket upgrade headers for `/ws`.

## License

MIT
