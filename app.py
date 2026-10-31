"""Desk concierge: a Cardputer left at your desk talks to visitors on your behalf.

Two clients hit this server:

- The device (Cardputer) authenticates with the X-Device-Token header. It
  posts visitor messages to /api/device/ask and gets Claude's reply back
  in the same response, and polls /api/device/updates for replies the
  owner typed in the web inbox.
- The owner's inbox (web/, Next.js + CopilotKit) calls /api/owner/* to
  watch conversations live, reply, and set their status. Next.js is the
  public server and proxies these paths here; this app listens on
  localhost only in production.

State lives in one SQLite file, so this runs as a single machine with a
volume on Fly.
"""

import json
import os
import secrets
import sqlite3
import time
from contextlib import closing
from typing import Literal

import anthropic
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel, Field

OWNER_NAME = os.environ.get("OWNER_NAME", "Ziad")
OWNER_PASSWORD = os.environ.get("OWNER_PASSWORD", "")
DEVICE_TOKEN = os.environ.get("DEVICE_TOKEN", "")
DB_PATH = os.environ.get("DB_PATH", "concierge.db")
MODEL = "claude-opus-5-5"

# The device font is ASCII-only and the screen is 240x135, so replies
# have to be short and plain.
REPLY_MAX_CHARS = 220
HISTORY_TURNS = 12

app = FastAPI()
# auto_error=False so a missing Authorization header reaches require_owner,
# which decides based on whether OWNER_PASSWORD is set.
basic = HTTPBasic(auto_error=False)
client = anthropic.AsyncAnthropic()


# --- storage --------------------------------------------------------------


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with closing(db()) as conn, conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                session TEXT NOT NULL,
                sender TEXT NOT NULL,      -- visitor | claude | owner | event
                text TEXT NOT NULL,
                urgent INTEGER NOT NULL DEFAULT 0,
                summary TEXT
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )


def get_setting(key, default=""):
    with closing(db()) as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key, value):
    with closing(db()) as conn, conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def add_message(session, sender, text, urgent=False, summary=None):
    with closing(db()) as conn, conn:
        cur = conn.execute(
            "INSERT INTO messages (ts, session, sender, text, urgent, summary) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (time.time(), session, sender, text, int(urgent), summary),
        )
        return cur.lastrowid


def session_history(session):
    with closing(db()) as conn:
        rows = conn.execute(
            "SELECT sender, text FROM messages WHERE session = ? ORDER BY id DESC LIMIT ?",
            (session, HISTORY_TURNS),
        ).fetchall()
    return list(reversed(rows))


def latest_session():
    with closing(db()) as conn:
        row = conn.execute("SELECT session FROM messages ORDER BY id DESC LIMIT 1").fetchone()
    return row["session"] if row else None


init_db()


# --- auth -----------------------------------------------------------------


def require_device(x_device_token: str = Header("")):
    if not DEVICE_TOKEN or not secrets.compare_digest(x_device_token, DEVICE_TOKEN):
        raise HTTPException(401, "bad device token")


def require_owner(creds: HTTPBasicCredentials | None = Depends(basic)):
    # With OWNER_PASSWORD unset the owner API is open (matches web/proxy.ts).
    if not OWNER_PASSWORD:
        return
    if creds is None or not secrets.compare_digest(creds.password, OWNER_PASSWORD):
        raise HTTPException(401, "bad password", headers={"WWW-Authenticate": "Basic"})


# --- Claude ---------------------------------------------------------------

REPLY_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "urgent": {"type": "boolean"},
        "summary": {"type": "string"},
    },
    "required": ["reply", "urgent", "summary"],
    "additionalProperties": False,
}


def system_prompt():
    status = get_setting("status") or "Away from the desk."
    context = get_setting("context") or "(nothing else shared)"
    return f"""You are the desk concierge for {OWNER_NAME}. You run on a small handheld \
device with a keyboard that {OWNER_NAME} left at their desk while they're away. \
People walk up and type to you.

{OWNER_NAME}'s current status: {status}
What {OWNER_NAME} wants visitors to know: {context}

How to reply:
- Answer as {OWNER_NAME}'s friendly assistant, never as {OWNER_NAME}.
- The screen is tiny: keep "reply" under {REPLY_MAX_CHARS} characters, plain ASCII, \
no markdown or emoji.
- Use only the status and info above. Don't make up {OWNER_NAME}'s plans or promise \
anything on their behalf; offer to pass a message along instead. Every conversation \
already shows up in {OWNER_NAME}'s inbox, so you can say so.
- If the visitor wants a name or contact back, ask for it.
- Lines from "{OWNER_NAME} (live)" were typed by {OWNER_NAME} from their inbox. \
They outrank the status above.

Set "urgent" to true only when {OWNER_NAME} should look right away: someone is \
waiting for them, a judge or organizer is looking for them, a time-sensitive \
request, or anything that sounds like a problem. Small talk and general questions \
are not urgent.

"summary" is a one-line note for {OWNER_NAME}'s inbox about what this visitor \
wants so far, e.g. "Maya from Acme wants to demo together at 3pm"."""


def to_api_messages(history):
    messages = []
    for row in history:
        if row["sender"] == "event":
            # Pickup / put-down notices are for the owner's feed, not the
            # visitor conversation.
            continue
        if row["sender"] == "visitor":
            messages.append({"role": "user", "content": row["text"]})
        elif row["sender"] == "claude":
            messages.append({"role": "assistant", "content": row["text"]})
        else:
            # Owner lines join the visitor's side of the transcript so the
            # roles keep alternating; the label tells Claude who said it.
            messages.append({"role": "user", "content": f"[{OWNER_NAME} (live)]: {row['text']}"})
    # The history window can cut mid-exchange; the API needs a user turn first.
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    return messages


def ascii_only(text):
    return "".join(c if 32 <= ord(c) < 127 else " " for c in text).strip()


async def ask_claude(history):
    try:
        response = await client.beta.messages.create(
            model=MODEL,
            max_tokens=2000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=system_prompt(),
            messages=to_api_messages(history),
            # Low effort: this is quick chat with someone standing at the
            # device, so latency matters more than depth.
            output_config={
                "effort": "low",
                "format": {"type": "json_schema", "schema": REPLY_SCHEMA},
            },
        )
    except anthropic.APIConnectionError:
        return {"reply": "I can't reach my brain right now. Try again in a moment?",
                "urgent": False, "summary": "(network error)"}
    except anthropic.APIStatusError as e:
        print(f"claude error {e.status_code}: {e.message}")
        return {"reply": "Something went wrong on my end. Try again in a moment?",
                "urgent": False, "summary": f"(API error {e.status_code})"}

    if response.stop_reason == "refusal":
        return {"reply": f"I can't help with that one, but {OWNER_NAME} will see your message.",
                "urgent": False, "summary": "(declined to answer)"}

    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Hit max_tokens mid-JSON or similar; show whatever we got.
        data = {"reply": text, "urgent": False, "summary": ""}
    data["reply"] = ascii_only(data["reply"])[:REPLY_MAX_CHARS * 2]
    return data


# --- device API -----------------------------------------------------------


class AskIn(BaseModel):
    session: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=500)


@app.get("/api/device/hello", dependencies=[Depends(require_device)])
def device_hello():
    with closing(db()) as conn:
        row = conn.execute("SELECT MAX(id) AS m FROM messages").fetchone()
    return {
        "owner": OWNER_NAME,
        "status": ascii_only(get_setting("status") or "Away from the desk."),
        "latest_id": row["m"] or 0,
    }


@app.post("/api/device/ask", dependencies=[Depends(require_device)])
async def device_ask(body: AskIn):
    add_message(body.session, "visitor", body.text)
    result = await ask_claude(session_history(body.session))
    msg_id = add_message(body.session, "claude", result["reply"],
                         urgent=result["urgent"], summary=result["summary"])
    return {"id": msg_id, "reply": result["reply"]}


class EventIn(BaseModel):
    session: str = Field(min_length=1, max_length=64)
    type: Literal["picked_up", "put_down"]


EVENT_TEXT = {
    "picked_up": "Someone picked up the device",
    "put_down": "The device was put back down",
}

# The device only reports put_down after it has been still this long
# (_PUTDOWN_STILL_MS in apps/concierge.py), so it was really set down that
# much earlier than the event arrives.
PUTDOWN_STILL_S = 2


def fmt_duration(seconds):
    seconds = max(1, round(seconds))
    if seconds < 60:
        return f"{seconds} second{'s' if seconds != 1 else ''}"
    minutes, seconds = divmod(seconds, 60)
    return f"{minutes} min {seconds} s"


@app.post("/api/device/event", dependencies=[Depends(require_device)])
def device_event(body: EventIn):
    text = EVENT_TEXT[body.type]
    if body.type == "put_down":
        with closing(db()) as conn:
            row = conn.execute(
                "SELECT ts FROM messages WHERE sender = 'event' AND text = ? "
                "ORDER BY id DESC LIMIT 1",
                (EVENT_TEXT["picked_up"],),
            ).fetchone()
        if row:
            held = time.time() - PUTDOWN_STILL_S - row["ts"]
            text += f" after {fmt_duration(held)}"
    msg_id = add_message(body.session, "event", text)
    return {"id": msg_id}


@app.get("/api/device/updates", dependencies=[Depends(require_device)])
def device_updates(after: int = 0):
    with closing(db()) as conn:
        rows = conn.execute(
            "SELECT id, text FROM messages WHERE sender = 'owner' AND id > ? ORDER BY id",
            (after,),
        ).fetchall()
    return {"messages": [{"id": r["id"], "text": ascii_only(r["text"])} for r in rows]}


# --- owner API ------------------------------------------------------------


class ReplyIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    session: str | None = None


class SettingsIn(BaseModel):
    status: str = Field(max_length=300)
    context: str = Field(max_length=2000)


@app.get("/api/owner/feed", dependencies=[Depends(require_owner)])
def owner_feed(after: int = 0):
    with closing(db()) as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE id > ? ORDER BY id DESC LIMIT 500", (after,)
        ).fetchall()
    return {"messages": [dict(r) for r in reversed(rows)]}


@app.post("/api/owner/reply", dependencies=[Depends(require_owner)])
def owner_reply(body: ReplyIn):
    session = body.session or latest_session() or "owner"
    msg_id = add_message(session, "owner", body.text)
    return {"id": msg_id}


@app.get("/api/owner/settings", dependencies=[Depends(require_owner)])
def owner_get_settings():
    return {"status": get_setting("status"), "context": get_setting("context")}


@app.post("/api/owner/settings", dependencies=[Depends(require_owner)])
def owner_set_settings(body: SettingsIn):
    set_setting("status", body.status)
    set_setting("context", body.context)
    return {"ok": True}


@app.get("/healthz")
def healthz():
    return {"ok": True}
