const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');

const AUTH_DIR = path.join(__dirname, '..', 'auth');
const MEDIA_DIR = path.join(__dirname, '..', 'media');
const logger = pino({ level: 'silent' });

function ensureMediaDir() {
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

const EXT_TO_MIME = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime])
);

function extFromMime(mimetype, fallback = '.bin') {
  if (!mimetype) return fallback;
  return MIME_TO_EXT[mimetype.toLowerCase()] || fallback;
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (EXT_TO_MIME[ext]) return EXT_TO_MIME[ext];
  if (ext === '.img') return 'image/jpeg';
  return 'application/octet-stream';
}

let sock = null;
let ready = false;
let connecting = false;
const MAX_MESSAGES = 500;
const messages = [];

async function connect() {
  if (connecting) return sock;
  connecting = true;

  if (sock) {
    sock.ev.removeAllListeners();
    sock = null;
  }

  const hasSession = fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
  console.log(hasSession ? `Restoring session from ${AUTH_DIR}` : `No saved session — scan QR to pair (${AUTH_DIR})`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger,
  });
  connecting = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrText = await qrcode.toString(qr, { type: 'terminal', small: true });
      console.log(qrText);
      console.log('Scan the QR code above with WhatsApp (Linked Devices) to log in.');
    }

    if (connection === 'open') {
      ready = true;
      console.log('WhatsApp connected.');
    }

    if (connection === 'close') {
      ready = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`Logged out. Delete ${AUTH_DIR} and restart to re-pair.`);
      } else {
        console.log('Connection closed, reconnecting in 3s...');
        setTimeout(connect, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages: incoming }) => {
    for (const msg of incoming) {
      processIncomingMessage(msg).catch((err) =>
        console.error('Failed to process message:', err.message)
      );
    }
  });

  return sock;
}

function isReady() {
  return ready;
}

function assertReady() {
  if (!ready || !sock) throw new Error('WhatsApp connection not ready');
}

function pushMessage(entry) {
  messages.push(entry);
  if (messages.length > MAX_MESSAGES) messages.shift();
}

async function saveIncomingMedia(msg, mimetype, fallbackExt = '.bin') {
  ensureMediaDir();
  const buffer = await downloadMediaMessage(
    msg,
    'buffer',
    {},
    { logger, reuploadRequest: sock.updateMediaMessage }
  );
  const ext = extFromMime(mimetype, fallbackExt);
  const mediaId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, mediaId), buffer);
  return mediaId;
}

function saveOutgoingMedia(buffer, mimetype) {
  ensureMediaDir();
  const ext = extFromMime(mimetype, '.bin');
  const mediaId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, mediaId), buffer);
  return mediaId;
}

async function processIncomingMessage(msg) {
  const from = msg.key.remoteJid;
  const contentType = getContentType(msg.message);
  const timestamp = Date.now();
  const name = msg.pushName || undefined;
  const base = { from, fromMe: !!msg.key.fromMe, timestamp, name };

  if (contentType === 'imageMessage') {
    const image = msg.message.imageMessage;
    const text = image.caption || '';
    const mediaId = await saveIncomingMedia(msg, image.mimetype, '.jpg');
    const entry = {
      ...base,
      type: 'image',
      text,
      mimetype: image.mimetype,
      mediaId,
    };
    pushMessage(entry);
    if (!msg.key.fromMe) console.log(`[incoming] ${from}: [image] ${text || image.mimetype}`);
    return;
  }

  if (contentType === 'documentMessage') {
    const doc = msg.message.documentMessage;
    const text = doc.caption || '';
    const mediaId = await saveIncomingMedia(msg, doc.mimetype, path.extname(doc.fileName || '') || '.bin');
    const entry = {
      ...base,
      type: 'document',
      text,
      mimetype: doc.mimetype,
      fileName: doc.fileName,
      mediaId,
    };
    pushMessage(entry);
    if (!msg.key.fromMe) console.log(`[incoming] ${from}: [document] ${doc.fileName || doc.mimetype}`);
    return;
  }

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    '';
  if (!text) return;

  pushMessage({
    ...base,
    type: 'text',
    text,
  });
  if (!msg.key.fromMe) console.log(`[incoming] ${from}: ${text}`);
}

async function resolveMediaInput(media) {
  if (media?.url) {
    return {
      payload: { url: media.url },
      mimetype: media.mimetype || 'application/octet-stream',
      buffer: null,
    };
  }
  if (media?.base64) {
    const raw = media.base64.includes(',') ? media.base64.split(',')[1] : media.base64;
    const buffer = Buffer.from(raw, 'base64');
    if (!buffer.length) throw new Error('Invalid base64 media data');
    return {
      payload: buffer,
      mimetype: media.mimetype || 'application/octet-stream',
      buffer,
    };
  }
  throw new Error('Media requires "url" or "base64"');
}

async function sendMessage(jid, text) {
  assertReady();
  await sock.sendMessage(jid, { text });
  return null;
}

async function sendImage(jid, image, caption = '') {
  assertReady();
  const { payload, mimetype, buffer } = await resolveMediaInput(image);
  const resolvedMime = image.mimetype || mimetype || 'image/jpeg';
  const content = { image: payload, mimetype: resolvedMime };
  if (caption) content.caption = caption;
  await sock.sendMessage(jid, content);

  if (!buffer) return null;
  const mediaId = saveOutgoingMedia(buffer, resolvedMime);
  pushMessage({
    from: jid,
    type: 'image',
    text: caption,
    mimetype: resolvedMime,
    mediaId,
    fromMe: true,
    timestamp: Date.now(),
  });
  return mediaId;
}

async function sendDocument(jid, document, caption = '') {
  assertReady();
  const { payload, mimetype, buffer } = await resolveMediaInput(document);
  const resolvedMime = document.mimetype || mimetype || 'application/octet-stream';
  const fileName = document.fileName || 'file';
  const content = {
    document: payload,
    mimetype: resolvedMime,
    fileName,
  };
  if (caption) content.caption = caption;
  await sock.sendMessage(jid, content);

  if (!buffer) return null;
  const mediaId = saveOutgoingMedia(buffer, resolvedMime);
  pushMessage({
    from: jid,
    type: 'document',
    text: caption,
    mimetype: resolvedMime,
    fileName,
    mediaId,
    fromMe: true,
    timestamp: Date.now(),
  });
  return mediaId;
}

function getMessages(sinceTimestamp) {
  if (!sinceTimestamp) return messages;
  const since = Number(sinceTimestamp) || 0;
  return messages.filter((m) => m.timestamp > since);
}

function getMediaPath(mediaId) {
  if (!mediaId || /[^a-zA-Z0-9._-]/.test(mediaId)) return null;
  const filePath = path.resolve(MEDIA_DIR, mediaId);
  if (!filePath.startsWith(path.resolve(MEDIA_DIR) + path.sep)) return null;
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

function getMediaContentType(mediaId) {
  const filePath = getMediaPath(mediaId);
  if (!filePath) return null;
  return mimeFromPath(filePath);
}

module.exports = {
  connect,
  isReady,
  sendMessage,
  sendImage,
  sendDocument,
  getMessages,
  getMediaPath,
  getMediaContentType,
  MEDIA_DIR,
};
