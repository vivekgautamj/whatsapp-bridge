function normalizeNumber(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

function toJid(raw) {
  const digits = normalizeNumber(raw);
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

module.exports = { normalizeNumber, toJid };
