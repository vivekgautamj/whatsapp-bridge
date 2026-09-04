const path = require('path');
const fs = require('fs');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');

const AUTH_DIR = path.join(__dirname, '..', 'auth');
const logger = pino({ level: 'silent' });

let sock = null;
let ready = false;
const MAX_MESSAGES = 500;
const messages = [];

async function connect() {
  const hasSession = fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
  console.log(hasSession ? `Restoring session from ${AUTH_DIR}` : `No saved session — scan QR to pair (${AUTH_DIR})`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger,
  });

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
      const from = msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';
      if (!text) continue;

      messages.push({
        from,
        text,
        fromMe: !!msg.key.fromMe,
        timestamp: Date.now(),
      });
      if (messages.length > MAX_MESSAGES) messages.shift();

      if (!msg.key.fromMe) console.log(`[incoming] ${from}: ${text}`);
    }
  });

  return sock;
}

function isReady() {
  return ready;
}

async function sendMessage(jid, text) {
  if (!ready || !sock) {
    throw new Error('WhatsApp connection not ready');
  }
  await sock.sendMessage(jid, { text });
}

function getMessages(sinceTimestamp) {
  if (!sinceTimestamp) return messages;
  const since = Number(sinceTimestamp) || 0;
  return messages.filter((m) => m.timestamp > since);
}

module.exports = { connect, isReady, sendMessage, getMessages };
