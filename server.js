require('dotenv').config();
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const POLL_MS = Number(process.env.POLL_MS || 5000);
const DEVICE_POLL_MS = Number(process.env.DEVICE_POLL_MS || 10000);
const API = 'https://api.textbee.dev/api/v1';
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

if (!process.env.TEXTBEE_API_KEY || !process.env.TEXTBEE_DEVICE_ID || !process.env.ADMIN_TOKEN) {
  console.error('Missing TEXTBEE_API_KEY, TEXTBEE_DEVICE_ID, or ADMIN_TOKEN in .env');
  process.exit(1);
}

let store = { messages: [], device: null, updatedAt: null };
let workerBusy = false;

async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    store = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
  } catch {
    await saveStore();
  }
}

async function saveStore() {
  store.updatedAt = new Date().toISOString();
  const tmp = STORE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmp, STORE_FILE);
}

function requireAuth(req, res, next) {
  const token = req.get('x-admin-token');
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function textbee(pathname, options = {}) {
  const response = await fetch(API + pathname, {
    ...options,
    headers: {
      'x-api-key': process.env.TEXTBEE_API_KEY,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const message = body?.message || body?.error || `TextBee HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function heartbeatState(device) {
  if (!device) return { status: 'unknown', ageMs: null, reason: 'No device data yet' };
  if (!device.enabled) return { status: 'offline', ageMs: null, reason: 'Device is disabled' };
  if (!device.lastHeartbeat) return { status: 'unknown', ageMs: null, reason: 'No heartbeat reported' };
  const ageMs = Date.now() - new Date(device.lastHeartbeat).getTime();
  const intervalMs = Math.max(Number(device.heartbeatIntervalMinutes || 1) * 60_000, 60_000);
  const onlineWindow = Math.max(intervalMs * 2.5, 120_000);
  return {
    status: ageMs <= onlineWindow ? 'online' : 'offline',
    ageMs,
    reason: ageMs <= onlineWindow ? 'Recent TextBee heartbeat' : 'Heartbeat is too old'
  };
}

async function refreshDevice() {
  try {
    const result = await textbee(`/gateway/devices/${encodeURIComponent(process.env.TEXTBEE_DEVICE_ID)}`);
    store.device = result.data || result;
    store.device._localStatus = heartbeatState(store.device);
    await saveStore();
    return store.device;
  } catch (error) {
    store.device = store.device || { _localStatus: { status: 'unknown', reason: 'Could not reach TextBee' } };
    store.device._localStatus = { status: 'unknown', reason: error.message };
    await saveStore();
    return null;
  }
}

async function updateFromBatch(message, batchId) {
  const result = await textbee(`/gateway/devices/${encodeURIComponent(process.env.TEXTBEE_DEVICE_ID)}/sms-batch/${encodeURIComponent(batchId)}`);
  const messages = result?.data?.messages || [];
  const target = messages.find(m => m.recipient === message.recipient) || messages[0];
  const status = target?.status || result?.data?.batch?.status;

  if (target?._id) message.textBeeMessageId = target._id;
  if (status) {
    message.status = normalizeStatus(status);
    message.lastError = target?.errorMessage || null;
    message.updatedAt = new Date().toISOString();
  }
  if (target?.sentAt) message.sentAt = target.sentAt;
  if (target?.deliveredAt) message.deliveredAt = target.deliveredAt;
  if (target?.failedAt) message.failedAt = target.failedAt;
  await saveStore();
}

function normalizeStatus(status) {
  const s = String(status).toLowerCase();
  if (['delivered'].includes(s)) return 'delivered';
  if (['sent', 'dispatched'].includes(s)) return 'sent';
  if (['failed'].includes(s)) return 'failed';
  return 'sending';
}

async function sendQueuedMessage(message) {
  const deviceState = heartbeatState(store.device);
  if (deviceState.status !== 'online') return false;

  message.status = 'sending';
  message.attempts = (message.attempts || 0) + 1;
  message.lastAttemptAt = new Date().toISOString();
  message.updatedAt = new Date().toISOString();
  await saveStore();

  try {
    const result = await textbee('/gateway/send-sms', {
      method: 'POST',
      body: JSON.stringify({
        message: message.message,
        recipients: [message.recipient],
        deviceId: process.env.TEXTBEE_DEVICE_ID
      })
    });

    const data = result?.data || result;
    if (data.smsBatchId) {
      message.textBeeBatchId = data.smsBatchId;
      message.status = 'sending';
      message.lastError = null;
      message.updatedAt = new Date().toISOString();
      await saveStore();
      await updateFromBatch(message, data.smsBatchId).catch(() => {});
    } else if (Number(data.successCount || 0) > 0) {
      message.status = 'sent';
      message.updatedAt = new Date().toISOString();
      await saveStore();
    } else if (Number(data.failureCount || 0) > 0) {
      message.status = 'queued';
      message.lastError = 'TextBee could not push the message to the device.';
      message.updatedAt = new Date().toISOString();
      await saveStore();
    }
    return true;
  } catch (error) {
    message.status = 'queued';
    message.lastError = error.message;
    message.updatedAt = new Date().toISOString();
    await saveStore();
    return false;
  }
}

async function syncSendingMessages() {
  for (const message of store.messages) {
    if (!message.textBeeBatchId || !['sending', 'sent'].includes(message.status)) continue;
    try {
      await updateFromBatch(message, message.textBeeBatchId);
    } catch {
      // Keep the last known status; next poll will try again.
    }
  }
}

async function workerTick() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    await refreshDevice();
    await syncSendingMessages();
    const pending = store.messages.filter(m => m.status === 'queued');
    for (const message of pending) {
      if (heartbeatState(store.device).status !== 'online') break;
      await sendQueuedMessage(message);
    }
  } finally {
    workerBusy = false;
  }
}

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  if (req.body?.token === process.env.ADMIN_TOKEN) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: 'Invalid admin token' });
});

app.get('/api/state', requireAuth, (req, res) => {
  const device = store.device ? { ...store.device, _localStatus: heartbeatState(store.device) } : null;
  res.json({ device, messages: store.messages, updatedAt: store.updatedAt });
});

app.post('/api/messages', requireAuth, async (req, res) => {
  const recipient = normalizeRwandaNumber(req.body?.recipient || '');
  const messageText = String(req.body?.message || '').trim();
  if (!recipient || !messageText) return res.status(400).json({ error: 'Recipient and message are required.' });

  const item = {
    id: crypto.randomUUID(),
    recipient,
    message: messageText,
    status: 'queued',
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    textBeeBatchId: null,
    textBeeMessageId: null,
    lastError: null
  };
  store.messages.unshift(item);
  await saveStore();
  await workerTick();
  res.status(201).json(item);
});


app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  const index = store.messages.findIndex(m => m.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Message not found' });

  const item = store.messages[index];

  if (item.status !== 'queued') {
    return res.status(400).json({ error: 'Only pending messages can be deleted' });
  }

  store.messages.splice(index, 1);
  await saveStore();

  res.json({ ok: true });
});
app.post('/api/retry/:id', requireAuth, async (req, res) => {
  const item = store.messages.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Message not found' });
  if (item.status === 'failed') item.status = 'queued';
  item.lastError = null;
  item.updatedAt = new Date().toISOString();
  await saveStore();
  await workerTick();
  res.json(item);
});

app.post('/api/refresh', requireAuth, async (req, res) => {
  await workerTick();
  res.json({ ok: true });
});

loadStore().then(async () => {
  await refreshDevice();
  setInterval(workerTick, POLL_MS);
  app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));
}).catch(error => {
  console.error(error);
  process.exit(1);
});
function normalizeRwandaNumber(number) {
  let n = String(number).trim().replace(/\s+/g, "");

  if (n.startsWith("+250")) return n;
  if (n.startsWith("250")) return "+" + n;
  if (n.startsWith("0")) return "+250" + n.slice(1);
  if (n.startsWith("7")) return "+250" + n;

  throw new Error("Invalid Rwanda phone number");
}

