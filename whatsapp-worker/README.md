# YARA WhatsApp Worker (isolated service)

This service is intentionally isolated under `whatsapp-worker/`. It does not change the existing Python API or dashboard.

## Important status

- WhatsApp connection is **off by default** (`WHATSAPP_ENABLED=false`).
- This uses the community-maintained Baileys WhatsApp Web protocol library. It is **not an official WhatsApp Business Platform integration**, is not endorsed by WhatsApp, and may disconnect or lead to account restrictions. Use only with the dedicated number and only after reviewing WhatsApp's terms and risks.
- Pairing must be initiated by the owner locally at the worker's HTTPS `/pair` page. Never send QR codes, pairing codes, auth files, or tokens in chat.
- The worker is read-only: it has no send-message endpoint or code path.
- Only group messages from group IDs already registered in `public.whatsapp_groups` for `YARA_OWNER_ID` with both `is_active=true` and `auto_read_enabled=true` are stored.
- It does not download media, sync full history, or backfill old messages. It stores new text messages received after connection.
- The existing dashboard does not yet provide a verified WhatsApp group-discovery/selection flow. Register the exact group JIDs only after the account is paired and group discovery is implemented; do not guess group IDs.

## Host requirements

Use Node.js 20 or newer. The service requires a **persistent writable disk** mounted at `/data` because Baileys authentication and Signal keys must survive worker restarts. Do not deploy with "No disk" unless you first implement and verify another encrypted persistent auth store.

Hostless configuration:
- Repository: `TanTan1978/YARA`
- Branch: `feature/whatsapp-worker`
- Working directory: `/whatsapp-worker`
- Build system: Detect automatically
- Command: `npm start`
- Container port: `8000`
- Persistent disk: mount at `/data`
- Size: Small (0.1 vCPU / 256 MiB) is only a smoke-test starting point; memory may need to be increased if the library is unstable or the service restarts.

## Required environment variables

Set these only in Hostless worker secrets. Never commit actual values:
- `SUPABASE_URL`: the YARA Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: server-side Supabase service-role secret; never expose it in the browser
- `YARA_APP_TOKEN`: long random secret used to protect the pairing/status endpoints
- `YARA_OWNER_ID`: UUID of the owner's Supabase Auth user
- `WHATSAPP_ENABLED=false` until the dedicated line is ready and the owner explicitly approves pairing
- `AUTH_DIR=/data/whatsapp-auth`
- `PORT=8000` (Hostless may inject this automatically)

Do not reuse the frontend publishable key as the service-role key.

## Endpoints

- `GET /health`: public liveness check; contains no secrets.
- `GET /pair`: local pairing page. It requires the owner to enter `YARA_APP_TOKEN` in the page.
- `GET /api/status`: bearer-token protected connection status.
- `GET /api/pair`: bearer-token protected QR data while pairing is pending.
- `GET /api/groups`: bearer-token protected list of explicitly registered groups.

## Database mapping

Uses the existing YARA tables:
- `whatsapp_groups(owner_id, external_group_id, group_name, is_active, auto_read_enabled)`
- `group_messages(owner_id, group_id, external_message_id, sender_name, message_text, sent_at)`

The service-role key bypasses RLS, so this service must remain private and its API token must be strong. Rotate secrets immediately if they are exposed.

## Before enabling

1. Confirm persistent disk is attached and test that a file survives a worker restart.
2. Set and verify all secrets.
3. Keep `WHATSAPP_ENABLED=false` until the dedicated number is ready.
4. Implement and test safe group discovery/selection before registering group IDs.
5. Pair only from the dedicated number's WhatsApp Linked Devices screen.
6. Verify messages are stored only for selected groups, and verify no outbound messages are possible.

Do not treat a running health endpoint as proof that WhatsApp is connected.
