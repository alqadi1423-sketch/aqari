#!/usr/bin/env node
/**
 * الجوال الافتراضي · ١١ (التوجيه الرابع ٦ · ١): صورة PNG لرمز QR فاتورةٍ ضريبية مصطنعة بصيغة هيئة الزكاة (Base64 لسلسلة TLV)،
 * تُدفع إلى معرض المحاكي فيقرؤها التطبيق من «قراءة QR الفاتورة» · بيانات مصطنعة بحروفٍ لاتينية، والرقم الضريبي بصيغة الهيئة.
 * الاستعمال: node e2e/qrInvoice.js <ملف.png>
 */
const fs = require('fs');
const zlib = require('zlib');
const qrcode = require('qrcode-generator');

const SELLER = 'E2E QR Supplier';
const VAT_NO = '300000000000003';
const ISSUED = '2026-11-01T09:00:00Z';
const TOTAL = '1150.00';
const VAT = '150.00';

function tlvBase64(pairs) {
  const out = [];
  for (const [tag, v] of pairs) {
    const b = Buffer.from(v, 'utf8');
    out.push(tag, b.length, ...b);
  }
  return Buffer.from(out).toString('base64');
}

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** رمزٌ بمقياس ١٢ بكسلاً للوحدة وهامش أربع وحدات، رماديٌّ ٨ بت */
function qrPng(text, scale = 12, quiet = 4) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + 2 * quiet) * scale;
  const raw = Buffer.alloc((size + 1) * size, 255);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0; // بلا ترشيح للسطر
    const r = Math.floor(y / scale) - quiet;
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / scale) - quiet;
      if (r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c)) raw[y * (size + 1) + 1 + x] = 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const payload = tlvBase64([[1, SELLER], [2, VAT_NO], [3, ISSUED], [4, TOTAL], [5, VAT]]);
if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.error('usage: node e2e/qrInvoice.js <out.png>'); process.exit(2); }
  fs.writeFileSync(out, qrPng(payload));
  console.log(out, payload);
}
module.exports = { payload, qrPng, SELLER, VAT_NO, TOTAL, VAT };
