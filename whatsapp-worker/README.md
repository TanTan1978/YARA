# YARA WhatsApp Worker

Isolated Node.js service in `whatsapp-worker/`; it does not replace the existing dashboard.

## Safety and status

- WhatsApp is **off by default**: `WHATSAPP_ENABLED=false`.
- Uses the community-maintained Baileys WhatsApp Web protocol, not the official WhatsApp Business Platform. It is unofficial, may disconnect, and may lead to account restrictions. Use only with a dedicated number and after reviewing the risks and applicable terms.
- Pairing is owner-operated at the worker's HTTPS `/pair` page. Never share QR codes, pairing codes, auth files, or tokens.
- Read-only: no code path or endpoint sends messages.
- Only explicitly selected groups are ingested.
- No full-history sync, no backfill, and no media downloads. Only new incoming text messages are stored.
- The worker is not an AI summarizer; summaries and schedules are not yet implemented.

## Hostless configuration

Create a **Standalone** worker:
- Repository: `TanTan1978/YARA`
- Branch: `main`
- Working directory: `/whatsapp-worker`
- Build system: Detect automatically
- Start command: `npm start`
- Container port: `8000`
- Node.js: 20 or newer

**Persistent storage is mandatory before pairing.** Mount a writable persistent disk at `/data`; authentication keys are stored at `/data/whatsapp-auth`. Do not pair if Hostless cannot provide persistent storage. Do not assume that an ephemeral filesystem survives restarts.

The Small (0.1 vCPU / 256 MiB) size is only a smoke-test starting point; increase memory if the process restarts or becomes unstable.

## Required server-side environment variables

Set these only in Hostless worker secrets:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side secret; never use the frontend publishable key)
- `YARA_APP_TOKEN` (long random secret)
- `YARA_OWNER_ID` (owner's Supabase Auth UUID)
- `WHATSAPP_ENABLED=false` until the dedicated line is ready and the owner explicitly approves pairing
- `AUTH_DIR=/data/whatsapp-auth`
- `PORT=8000` (if not injected by Hostless)

Never commit actual secret values.

## Endpoints

- `GET /health`: public liveness only.
- `GET /pair`: pairing page; enter the app token locally in the browser.
- `GET /api/status`: protected status.
- `GET /api/pair`: protected QR data.
- `GET /api/discover-groups`: protected group discovery.
- `POST /api/groups/select`: protect and explicitly enable/disable selected groups.
- `GET /api/groups`: protected selected-group list.

## Database

Uses:
- `whatsapp_groups(owner_id, external_group_id, group_name, is_active, auto_read_enabled)`
- `group_messages(owner_id, group_id, external_message_id, sender_name, message_text, sent_at)`

The required unique constraints have been verified:
- `whatsapp_groups(owner_id, external_group_id)`
- `group_messages(group_id, external_message_id)`

The service-role key bypasses RLS. Keep the worker private and the app token strong.

## Before enabling

1. Attach persistent storage at `/data` and verify files survive a restart.
2. Set all secrets in Hostless only.
3. Keep `WHATSAPP_ENABLED=false` until the dedicated number is ready.
4. Pair only by scanning the QR locally on the dedicated number.
5. Discover groups and explicitly select only groups whose members have been informed and authorized.
6. Verify that only selected groups are stored and that no outbound messages are possible.

A healthy `/health` response does not mean WhatsApp is connected.
