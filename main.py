import os, hmac
from datetime import datetime, timezone
from typing import Optional
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse
from supabase import create_client, Client

load_dotenv()
app = FastAPI(title="YARA AI", version="0.2.0")
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
YARA_APP_TOKEN = os.getenv("YARA_APP_TOKEN", "")

def get_db() -> Client:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(503, "Supabase server credentials are not configured")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

def authorize(value: Optional[str]):
    token = value.removeprefix("Bearer ").strip() if value else ""
    if not YARA_APP_TOKEN or not token or not hmac.compare_digest(token, YARA_APP_TOKEN):
        raise HTTPException(401, "Unauthorized")

@app.get("/", response_class=HTMLResponse)
async def dashboard():
    with open("index.html", encoding="utf-8") as f:
        return f.read()

@app.get("/health")
async def health():
    return {"status": "ok", "service": "YARA AI", "version": "0.2.0"}

@app.get("/api/status")
async def status():
    db = get_db()
    try:
        groups = db.table("yara_groups").select("id", count="exact").execute()
        messages = db.table("yara_messages").select("id", count="exact").execute()
        summaries = db.table("yara_summaries").select("id", count="exact").execute()
        return {"database": "connected", "groups": groups.count or 0,
                "messages": messages.count or 0, "summaries": summaries.count or 0,
                "ai_provider_configured": bool(os.getenv("OPENAI_API_KEY")),
                "whatsapp_group_integration": "not_configured"}
    except Exception as exc:
        raise HTTPException(502, f"Supabase query failed: {type(exc).__name__}")

@app.post("/api/groups")
async def add_group(request: Request, authorization: Optional[str] = Header(default=None)):
    authorize(authorization)
    data = await request.json()
    external_id = str(data.get("whatsapp_group_id", "")).strip()
    name = str(data.get("group_name", "")).strip()
    if not external_id or not name:
        raise HTTPException(400, "whatsapp_group_id and group_name are required")
    language = data.get("language_preference", "auto")
    if language not in ("auto", "ar", "en", "both"):
        raise HTTPException(400, "Invalid language_preference")
    try:
        result = get_db().table("yara_groups").upsert({
            "whatsapp_group_id": external_id, "group_name": name,
            "language_preference": language, "is_active": True,
            "updated_at": datetime.now(timezone.utc).isoformat()
        }, on_conflict="whatsapp_group_id").execute()
        return {"ok": True, "group": result.data[0] if result.data else None}
    except Exception as exc:
        raise HTTPException(502, f"Could not save group: {type(exc).__name__}")

@app.post("/api/import")
async def import_messages(request: Request, authorization: Optional[str] = Header(default=None)):
    authorize(authorization)
    data = await request.json()
    external_id = str(data.get("whatsapp_group_id", "")).strip()
    name = str(data.get("group_name", "")).strip()
    messages = data.get("messages", [])
    if not external_id or not name:
        raise HTTPException(400, "whatsapp_group_id and group_name are required")
    if not isinstance(messages, list) or len(messages) > 3000:
        raise HTTPException(400, "messages must be a list of up to 3000 items")
    db = get_db()
    try:
        group_result = db.table("yara_groups").upsert({
            "whatsapp_group_id": external_id, "group_name": name,
            "is_active": True, "updated_at": datetime.now(timezone.utc).isoformat()
        }, on_conflict="whatsapp_group_id").execute()
        group = group_result.data[0]
        rows = []
        for item in messages:
            body = str(item.get("body", "")).strip()
            if body:
                rows.append({"group_id": group["id"],
                    "whatsapp_message_id": item.get("message_id") or None,
                    "sender_id": str(item.get("sender_id", "")) or None,
                    "sender_name": str(item.get("sender_name", "")) or None,
                    "message_body": body, "message_timestamp": item.get("time") or None})
        inserted = 0
        if rows:
            result = db.table("yara_messages").insert(rows).execute()
            inserted = len(result.data or [])
        return {"ok": True, "accepted": inserted, "group_id": group["id"]}
    except Exception as exc:
        raise HTTPException(502, f"Message import failed: {type(exc).__name__}")

@app.post("/api/summaries/run")
async def run_summary(request: Request, authorization: Optional[str] = Header(default=None)):
    authorize(authorization)
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(503, "AI summarization provider is not configured yet")
    raise HTTPException(501, "Summarization adapter is not implemented yet; no summary was fabricated")
