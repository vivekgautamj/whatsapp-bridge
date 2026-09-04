const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');

const logger = pino({ level: 'silent' });

let sock = null;
let ready = false;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');

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
        console.log('Logged out. Delete the auth/ folder and restart to re-pair.');
      } else {
        console.log('Connection closed, reconnecting in 3s...');
        setTimeout(connect, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';
      if (text) console.log(`[incoming] ${from}: ${text}`);
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

module.exports = { connect, isReady, sendMessage };
