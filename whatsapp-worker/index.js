import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const PORT = Number(process.env.PORT || 8000);
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APP_TOKEN = process.env.YARA_APP_TOKEN || '';
const OWNER_ID = process.env.YARA_OWNER_ID || '';
const AUTH_DIR = process.env.AUTH_DIR || '/data/whatsapp-auth';
const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED === 'true';

let socket = null;
let connectionState = 'disabled';
let currentQr = null;
let lastError = null;
let reconnectTimer = null;
let reconnectDelay = 5000;
let starting = false;

const configured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && APP_TOKEN && OWNER_ID);
const db = configured
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!APP_TOKEN || !constantTimeEqual(token, APP_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function messageText(message) {
  const m = message?.message;
  if (!m) return '';
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || m.documentWithCaptionMessage?.message?.documentMessage?.caption
    || '';
}

function sentAt(message) {
  const raw = message?.messageTimestamp;
  if (!raw) return new Date().toISOString();
  const seconds = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : new Date().toISOString();
}

async function storeIncomingMessage(message) {
  if (!db || !message?.key || message.key.fromMe) return;
  const jid = message.key.remoteJid || '';
  if (!jid.endsWith('@g.us')) return; // Group messages only.
  const text = messageText(message);
  if (!text.trim()) return; // Ignore media-only/system events; no media is downloaded.

  const { data: group, error: groupError } = await db
    .from('whatsapp_groups')
    .select('id, owner_id')
    .eq('owner_id', OWNER_ID)
    .eq('external_group_id', jid)
    .eq('is_active', true)
    .eq('auto_read_enabled', true)
    .maybeSingle();

  if (groupError) throw groupError;
  if (!group) return; // Only groups explicitly registered/enabled by the owner.

  const row = {
    owner_id: OWNER_ID,
    group_id: group.id,
    external_message_id: message.key.id || null,
    sender_name: message.pushName || message.key.participant || null,
    message_text: text.slice(0, 12000),
    sent_at: sentAt(message)
  };

  const { error } = await db.from('group_messages').upsert(row, {
    onConflict: 'group_id,external_message_id',
    ignoreDuplicates: true
  });
  if (error) throw error;
}

async function connectWhatsApp() {
  if (starting || !WHATSAPP_ENABLED) return;
  starting = true;
  connectionState = 'starting';
  lastError = null;

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    await fs.promises.access(AUTH_DIR, fs.constants.R_OK | fs.constants.W_OK);
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    socket = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu('YARA AI'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined
    });

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
      if (qr) {
        currentQr = qr;
        connectionState = 'pairing_required';
      }
      if (connection === 'open') {
        currentQr = null;
        connectionState = 'connected';
        lastError = null;
        reconnectDelay = 5000;
      }
      if (connection === 'close') {
        currentQr = null;
        connectionState = 'disconnected';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          connectionState = 'logged_out';
          lastError = 'WhatsApp session logged out. Clear/re-pair only after owner approval.';
          return;
        }
        scheduleReconnect();
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages || []) {
        try {
          await storeIncomingMessage(message);
        } catch (error) {
          // Never log message bodies or credentials.
          lastError = 'Message storage failed: ' + (error?.name || 'Error');
          console.error(lastError);
        }
      }
    });
  } catch (error) {
    connectionState = 'error';
    lastError = error?.message || 'Worker startup failed';
    console.error('YARA WhatsApp worker startup failed:', lastError);
    scheduleReconnect();
  } finally {
    starting = false;
  }
}

function scheduleReconnect() {
  if (!WHATSAPP_ENABLED || reconnectTimer || connectionState === 'logged_out') return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    await connectWhatsApp();
  }, reconnectDelay);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'YARA WhatsApp worker' });
});

app.get('/pair', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YARA WhatsApp pairing</title>
<style>
body{margin:0;background:#0b0c0f;color:#f7f3ea;font:16px system-ui;padding:24px}
main{max-width:520px;margin:8vh auto;background:#17191e;border:1px solid #665638;border-radius:18px;padding:24px}
h1{color:#e4ca91}input,button{font:inherit;padding:12px;border-radius:9px;width:100%;box-sizing:border-box;margin:8px 0}
input{background:#0b0c0f;border:1px solid #555;color:white}button{background:#dfc58e;border:0;font-weight:700}
#qr{display:block;max-width:100%;margin:20px auto;background:white;padding:12px;border-radius:10px}
small{color:#aaa;line-height:1.5}.status{margin-top:14px;color:#e4ca91;white-space:pre-wrap}
</style>
<main><h1>YARA AI · WhatsApp pairing</h1>
<p>Enter the worker token configured by the owner. It stays in this tab only.</p>
<input id="token" type="password" autocomplete="off" placeholder="YARA_APP_TOKEN">
<button id="check">Check connection / show QR</button>
<div id="status" class="status">Waiting for owner authentication.</div><img id="qr" hidden alt="WhatsApp linked-device QR">
<button id="discover" type="button">Discover my WhatsApp groups</button><div id="groups"></div>
<small>Scan only with the dedicated YARA WhatsApp number. Never share this page, QR, or token. Select only groups whose members have been informed and authorized. This service is read-only and stores only text from selected groups.</small></main>
<script>
const token=document.getElementById('token'),status=document.getElementById('status'),qr=document.getElementById('qr');
async function api(url,options={}) {
 const response=await fetch(url,{...options,headers:{Authorization:'Bearer '+token.value,'Content-Type':'application/json',...(options.headers||{})}});
 const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed');return data;
}
document.getElementById('check').onclick=async()=>{
 status.textContent='Checking…';qr.hidden=true;
 try{
  const d=await api('/api/pair');
  status.textContent='Connection: '+d.connection_state+(d.last_error?'\\n'+d.last_error:'');
  if(d.qr_data_url){qr.src=d.qr_data_url;qr.hidden=false}
 }catch(e){status.textContent=e.message}
};
document.getElementById('discover').onclick=async()=>{
 const box=document.getElementById('groups');box.textContent='Loading groups…';
 try{
  const d=await api('/api/discover-groups');
  box.innerHTML=d.groups.map(g=>'<label style="display:block;padding:10px;border-top:1px solid #444"><input type="checkbox" data-jid="'+g.jid+'" data-name="'+String(g.name).replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'" '+(g.enabled?'checked':'')+' style="width:auto"> '+String(g.name).replace(/</g,'&lt;')+'</label>').join('')||'No groups found.';
  box.querySelectorAll('input[type=checkbox]').forEach(el=>el.addEventListener('change',async()=>{
   try{await api('/api/groups/select',{method:'POST',body:JSON.stringify({group_jid:el.dataset.jid,group_name:el.dataset.name,enabled:el.checked})});}
   catch(e){el.checked=!el.checked;status.textContent=e.message}
  }));
 }catch(e){box.textContent=e.message}
};
</script></html>`);
});

app.get('/api/status', requireToken, (_req, res) => {
  res.json({
    configured,
    whatsapp_enabled: WHATSAPP_ENABLED,
    connection_state: connectionState,
    last_error: lastError,
    persistent_auth_dir: AUTH_DIR
  });
});

app.get('/api/pair', requireToken, async (_req, res) => {
  let qrDataUrl = null;
  if (currentQr) qrDataUrl = await QRCode.toDataURL(currentQr, { margin: 1, width: 320 });
  res.json({ connection_state: connectionState, qr_data_url: qrDataUrl, last_error: lastError });
});

app.get('/api/discover-groups', requireToken, async (_req, res) => {
  if (!socket || connectionState !== 'connected') {
    return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  }
  try {
    const participating = await socket.groupFetchAllParticipating();
    const { data: saved, error } = await db.from('whatsapp_groups')
      .select('external_group_id, is_active, auto_read_enabled')
      .eq('owner_id', OWNER_ID);
    if (error) throw error;
    const savedMap = new Map((saved || []).map(g => [g.external_group_id, g]));
    const groups = Object.entries(participating || {}).map(([jid, meta]) => {
      const row = savedMap.get(jid);
      return {
        jid,
        name: meta.subject || 'WhatsApp group',
        enabled: Boolean(row?.is_active && row?.auto_read_enabled)
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ groups });
  } catch (error) {
    res.status(502).json({ error: 'Could not discover groups: ' + (error?.name || 'Error') });
  }
});

app.post('/api/groups/select', requireToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database is not configured' });
  const jid = String(req.body?.group_jid || '');
  const name = String(req.body?.group_name || '').slice(0, 120);
  const enabled = req.body?.enabled === true;
  if (!jid.endsWith('@g.us') || !name) {
    return res.status(400).json({ error: 'A valid discovered group and name are required' });
  }
  const { data, error } = await db.from('whatsapp_groups').upsert({
    owner_id: OWNER_ID,
    external_group_id: jid,
    group_name: name,
    is_active: enabled,
    auto_read_enabled: enabled,
    updated_at: new Date().toISOString()
  }, { onConflict: 'owner_id,external_group_id' }).select('id, group_name, is_active').single();
  if (error) return res.status(502).json({ error: 'Could not update group selection' });
  res.json({ ok: true, group: data });
});

app.get('/api/groups', requireToken, async (_req, res) => {
  if (!db) return res.status(503).json({ error: 'Database is not configured' });
  const { data, error } = await db.from('whatsapp_groups')
    .select('id, external_group_id, group_name, is_active, auto_read_enabled')
    .eq('owner_id', OWNER_ID).order('created_at', { ascending: false });
  if (error) return res.status(502).json({ error: 'Could not load groups' });
  res.json({ groups: data || [] });
});

app.get('/', (_req, res) => res.redirect('/pair'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`YARA WhatsApp worker listening on port ${PORT}; enabled=${WHATSAPP_ENABLED}`);
  if (!configured) console.warn('Missing required server-side environment variables; WhatsApp remains inactive.');
  if (WHATSAPP_ENABLED && configured) connectWhatsApp();
  else connectionState = WHATSAPP_ENABLED ? 'configuration_error' : 'disabled';
});
