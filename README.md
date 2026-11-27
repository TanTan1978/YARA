# YARA AI

Premium Arabic/English WhatsApp group summarization project.

## Repository layout

- `index.html`: existing YARA dashboard frontend.
- `whatsapp-worker/`: isolated Node.js worker for the dedicated WhatsApp account.
- Root-level Python files are an earlier API prototype; do not use them as the WhatsApp worker.

## WhatsApp worker status

The worker code is now present on `main` under `whatsapp-worker/`. It uses the community-maintained Baileys WhatsApp Web protocol library, not the official WhatsApp Business Platform. This is unofficial and may disconnect or lead to WhatsApp account restrictions. Use a dedicated number only, and review the applicable WhatsApp terms and risks.

Safety defaults:
- `WHATSAPP_ENABLED=false`; no WhatsApp pairing starts until the owner explicitly changes this server-side setting.
- Read-only: no send/reply endpoint.
- Only selected group IDs with both `is_active=true` and `auto_read_enabled=true` are stored.
- No full-history sync, no backfill, and no media downloads; only new incoming text messages are stored.
- QR codes, pairing codes, auth files, service-role keys, and app tokens must never be committed to GitHub or shared in chat.

## Hostless worker configuration

Create a **Standalone** worker using:
- Repository: `TanTan1978/YARA`
- Branch: `main`
- Working directory: `/whatsapp-worker`
- Build system: Detect automatically
- Start command: `npm start`
- Container port: `8000`
- Node.js: 20 or newer (Node.js 24 is acceptable)

Important: Baileys auth keys must persist across restarts. The worker requires a writable persistent disk mounted at `/data`, with `AUTH_DIR=/data/whatsapp-auth`. Do not pair WhatsApp on a host where persistent storage is unavailable. A running process without persistent auth storage is not a reliable deployment.

The smallest 256 MiB instance is only a smoke-test starting point; memory may need to be increased.

## Required Hostless secrets (server-side only)

- `SUPABASE_URL`: YARA Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service-role secret (never use the publishable key here)
- `YARA_APP_TOKEN`: long random secret for protected worker endpoints
- `YARA_OWNER_ID`: owner's Supabase Auth user UUID
- `WHATSAPP_ENABLED=false` until the dedicated line is ready and the owner explicitly approves pairing
- `AUTH_DIR=/data/whatsapp-auth`
- `PORT=8000` (if not injected by Hostless)

Never put these values in `index.html`, GitHub, screenshots, or chat.

## Worker endpoints

- `GET /health`: public liveness check only; does not prove WhatsApp is connected.
- `GET /pair`: owner-operated pairing page.
- `GET /api/status`: token-protected status.
- `GET /api/pair`: token-protected QR data.
- `GET /api/discover-groups`: token-protected group discovery.
- `POST /api/groups/select`: token-protected explicit group selection.
- `GET /api/groups`: token-protected selected groups.

Pair only by scanning the QR locally from WhatsApp > Linked devices on the dedicated number. Never send the QR or session credentials to anyone.

## Database

The worker uses the existing `public.whatsapp_groups` and `public.group_messages` tables. The required unique constraints were verified:
- `whatsapp_groups(owner_id, external_group_id)`
- `group_messages(group_id, external_message_id)`

The service-role key bypasses RLS; protect the worker and its secrets accordingly.

## Not implemented yet

The WhatsApp worker does not itself create AI summaries or schedules. The dashboard, AI summarization, daily/on-demand scheduling, and the worker still need integration and end-to-end testing before YARA is operational.
