import os, json, hmac, hashlib, sqlite3, logging
from datetime import datetime, timezone
from contextlib import contextmanager
from typing import Optional

from fastapi import FastAPI, Request, HTTPException, Header
from fastapi.responses import HTMLResponse, PlainTextResponse
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("yara")

DB_PATH = os.getenv("YARA_DB_PATH", "data/yara.db")
APP_TOKEN = os.getenv("YARA_APP_TOKEN", "")
VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "")
WA_APP_SECRET = os.getenv("WHATSAPP_APP_SECRET", "")
scheduler = AsyncIOScheduler(timezone=os.getenv("TZ", "Asia/Riyadh"))

app = FastAPI(title="YARA AI", version="0.1.0")


@contextmanager
def database():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            conversation_name TEXT,
            sender TEXT,
            body TEXT NOT NULL,
            message_time TEXT,
            created_at TEXT NOT NULL
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            conversation_name TEXT,
            language TEXT NOT NULL,
            summary TEXT NOT NULL,
            created_at TEXT NOT NULL,
            trigger_type TEXT NOT NULL
        )""")
        conn.commit()
        yield conn
    finally:
        conn.close()


def check_app_token(authorization: Optional[str]):
    if not APP_TOKEN:
        raise HTTPException(503, "YARA_APP_TOKEN is not configured")
    token = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not token or not hmac.compare_digest(token, APP_TOKEN):
        raise HTTPException(401, "Unauthorized")


def ai_provider_ready():
    return bool(os.getenv("OPENAI_API_KEY"))


@app.on_event("startup")
async def startup():
    with database():
        pass
    if os.getenv("ENABLE_DAILY_SCHEDULER", "false").lower() == "true":
        scheduler.add_job(daily_summary_placeholder, "cron", hour=int(os.getenv("SUMMARY_HOUR", "20")),
                          minute=0, id="daily-summaries", replace_existing=True)
        scheduler.start()


@app.on_event("shutdown")
async def shutdown():
    if scheduler.running:
        scheduler.shutdown(wait=False)


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    with open("index.html", encoding="utf-8") as f:
        return f.read()


@app.get("/health")
async def health():
    return {"status": "ok", "service": "YARA AI", "version": "0.1.0"}


@app.get("/webhooks/whatsapp", response_class=PlainTextResponse)
async def verify_webhook(request: Request):
    q = request.query_params
    if q.get("hub.mode") == "subscribe" and VERIFY_TOKEN and hmac.compare_digest(
        q.get("hub.verify_token", ""), VERIFY_TOKEN
    ):
        return q.get("hub.challenge", "")
    raise HTTPException(403, "Webhook verification failed")


@app.post("/webhooks/whatsapp")
async def receive_webhook(request: Request, x_hub_signature_256: Optional[str] = Header(default=None)):
    raw = await request.body()
    if not WA_APP_SECRET:
        raise HTTPException(503, "Webhook signature secret is not configured")
    expected = "sha256=" + hmac.new(WA_APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    if not x_hub_signature_256 or not hmac.compare_digest(expected, x_hub_signature_256):
        raise HTTPException(401, "Invalid webhook signature")

    payload = json.loads(raw or b"{}")
    stored = 0
    # Generic WhatsApp Business webhook message ingestion.
    # This does NOT imply support for ordinary WhatsApp group history/messages.
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            contacts = {
                item.get("wa_id"): item.get("profile", {}).get("name")
                for item in value.get("contacts", [])
            }
            for msg in value.get("messages", []):
                body = msg.get("text", {}).get("body")
                if not body:
                    continue
                conversation_id = str(msg.get("from", "unknown"))
                stamp = msg.get("timestamp", "")
                message_time = datetime.fromtimestamp(int(stamp), timezone.utc).isoformat() if str(stamp).isdigit() else ""
                with database() as conn:
                    conn.execute(
                        """INSERT INTO messages
                        (source, conversation_id, conversation_name, sender, body, message_time, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)""",
                        ("whatsapp_business_webhook", conversation_id, None,
                         contacts.get(msg.get("from")), body, message_time,
                         datetime.now(timezone.utc).isoformat())
                    )
                    conn.commit()
                stored += 1
    return {"ok": True, "stored": stored}


@app.post("/api/import")
async def import_messages(request: Request, authorization: Optional[str] = Header(default=None)):
    check_app_token(authorization)
    data = await request.json()
    conversation_id = str(data.get("conversation_id", "")).strip()
    if not conversation_id:
        raise HTTPException(400, "conversation_id is required")
    conversation_name = str(data.get("conversation_name", "Imported conversation"))
    messages = data.get("messages", [])
    if not isinstance(messages, list) or len(messages) > 3000:
        raise HTTPException(400, "messages must be a list of up to 3000 items")
    accepted = 0
    with database() as conn:
        for item in messages:
            body = str(item.get("body", "")).strip()
            if body:
                conn.execute(
                    """INSERT INTO messages
                    (source, conversation_id, conversation_name, sender, body, message_time, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    ("authorized_import", conversation_id, conversation_name,
                     str(item.get("sender", "")), body, str(item.get("time", "")),
                     datetime.now(timezone.utc).isoformat())
                )
                accepted += 1
        conn.commit()
    return {"ok": True, "accepted": accepted, "conversation_id": conversation_id}


@app.get("/api/status")
async def status():
    with database() as conn:
        groups = conn.execute("SELECT COUNT(DISTINCT conversation_id) n FROM messages").fetchone()["n"]
        count = conn.execute("SELECT COUNT(*) n FROM messages").fetchone()["n"]
    return {
        "groups_or_conversations_with_messages": groups,
        "messages_stored": count,
        "ai_provider_configured": ai_provider_ready(),
        "daily_scheduler_enabled": os.getenv("ENABLE_DAILY_SCHEDULER", "false").lower() == "true",
        "whatsapp_webhook_signature_configured": bool(WA_APP_SECRET),
    }


@app.post("/api/summaries/run")
async def run_summary(request: Request, authorization: Optional[str] = Header(default=None)):
    check_app_token(authorization)
    data = await request.json()
    conversation_id = str(data.get("conversation_id", "")).strip()
    language = data.get("language", "auto")
    if not conversation_id:
        raise HTTPException(400, "conversation_id is required")
    with database() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 300",
            (conversation_id,)
        ).fetchall()
        if not rows:
            raise HTTPException(404, "No messages found")
        if not ai_provider_ready():
            raise HTTPException(503, "AI provider is not configured; no summary was generated")
        # Summarization intentionally remains unimplemented until provider/model settings
        # and retention policy are explicitly configured and tested.
        raise HTTPException(501, "AI summarization adapter is the next implementation step")


async def daily_summary_placeholder():
    log.warning("Daily summaries are not activated until an AI provider is configured and tested.")
