const http = require('http');
const fs = require('fs');
const { URL } = require('url');
const {
  connect,
  isReady,
  sendMessage,
  sendImage,
  sendDocument,
  getMessages,
  getMediaPath,
  getMediaContentType,
} = require('./whatsapp');
const { toJid } = require('./config');

const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 15 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function hasMediaSource(media) {
  return !!(media && (media.url || media.base64));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/messages') {
    const since = url.searchParams.get('since');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ready: isReady(), messages: getMessages(since) }));
  }

  const mediaMatch = url.pathname.match(/^\/media\/([^/]+)$/);
  if (req.method === 'GET' && mediaMatch) {
    const mediaId = mediaMatch[1];
    const filePath = getMediaPath(mediaId);
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Media not found' }));
    }
    const contentType = getMediaContentType(mediaId) || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=3600',
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  if (req.method === 'POST' && url.pathname === '/notify') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      const status = err.message === 'Payload too large' ? 413 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          error: status === 413 ? 'Payload too large' : 'Invalid JSON body',
        })
      );
    }

    const jid = toJid(body.number);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const hasImage = body.image && typeof body.image === 'object';
    const hasDocument = body.document && typeof body.document === 'object';

    if (!jid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Requires valid "number" field' }));
    }

    if (!message && !hasImage && !hasDocument) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ error: 'Requires "message", "image", or "document" field' })
      );
    }

    if (hasDocument && !body.document.fileName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'document.fileName is required' }));
    }

    if (hasImage && !hasMediaSource(body.image)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'image requires "url" or "base64"' }));
    }

    if (hasDocument && !hasMediaSource(body.document)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'document requires "url" or "base64"' }));
    }

    if (!isReady()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'WhatsApp not connected yet' }));
    }

    try {
      let mediaId = null;
      if (hasImage) {
        mediaId = await sendImage(jid, body.image, message);
      } else if (hasDocument) {
        mediaId = await sendDocument(jid, body.document, message);
      } else {
        await sendMessage(jid, message);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'sent', mediaId: mediaId || undefined }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

connect();

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('POST /notify — text: { "number", "message" }');
  console.log('POST /notify — image: { "number", "message"?, "image": { "url"|"base64", "mimetype"? } }');
  console.log('POST /notify — doc: { "number", "message"?, "document": { "url"|"base64", "fileName", "mimetype"? } }');
  console.log('GET  /messages?since=<timestamp>');
  console.log('GET  /media/<mediaId>');
});
