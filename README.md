# YARA AI

Premium Arabic/English WhatsApp conversation summarization platform.

## Current status

This repository contains the initial FastAPI service scaffold and a responsive dashboard shell. It is **not yet a functioning WhatsApp group reader or AI summarizer**.

Important constraints:
- The WhatsApp Business webhook parser is a generic inbound-message example. It does not provide access to ordinary WhatsApp group chats or historical messages.
- Automatic reading of multiple WhatsApp groups must use an officially supported and authorized WhatsApp integration. Do not use unofficial WhatsApp Web automation or ask users to expose session QR codes.
- AI summarization is intentionally not enabled until a provider, model, privacy/retention settings, and tests are configured.
- Daily scheduling remains disabled by default.
- SQLite data must be stored on persistent storage. Ephemeral container storage can lose messages on restart/redeploy.

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000`.

## Hostless

- Build system: Detect automatically
- Build command: leave empty
- Runtime command: `uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}`
- Container port: `8000`
- Configure persistent storage mounted at `/data` before production use.
- Add secrets as environment variables in Hostless; never commit `.env` or real tokens.

## Next implementation milestones

1. Confirm a supported WhatsApp group-message integration and its eligibility.
2. Add provider-backed Arabic/English summarization with explicit language detection.
3. Add group registry, per-group permissions, daily summaries, on-demand summaries, and retention/deletion controls.
4. Add authentication and role-based access for dashboard users.
5. Add integration and deployment tests before production use.
