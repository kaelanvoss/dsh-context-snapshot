export const MAX_PNG_BYTES = 12 * 1024 * 1024;
export const MAX_TEXT_CHARS = 16000;
export const MAX_LINE_BYTES = 18 * 1024 * 1024;

export function validateCapture(value) {
  if (!value || typeof value !== 'object' || typeof value.pngBase64 !== 'string') throw new Error('Invalid capture payload');
  const b64 = value.pngBase64;
  if (b64.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4) throw new Error('Invalid or oversized PNG');
  const png = Buffer.from(b64, 'base64');
  if (png.length > MAX_PNG_BYTES || png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Capture must be PNG');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 80_000_000) throw new Error('Invalid PNG dimensions');
  const clean = (s, limit) => typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit) : '';
  return { pngBase64: b64, width, height, title: clean(value.title, 512), appName: clean(value.appName, 256), bundleId: clean(value.bundleId, 256), pid: Number.isSafeInteger(value.pid) ? value.pid : undefined, text: clean(value.text, MAX_TEXT_CHARS), capturedAt: Number.isFinite(Date.parse(value.capturedAt)) ? value.capturedAt : new Date().toISOString() };
}

/** Bound before JSON.parse; native output is never a command or a file path. */
export class LineDecoder {
  chunks = [];
  size = 0;
  dropping = false;
  constructor(onFrame, onError) { this.onFrame = onFrame; this.onError = onError; }
  get pending() { return Buffer.concat(this.chunks, this.size); }
  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);
      if (!this.dropping && this.size + part.length > MAX_LINE_BYTES) {
        this.chunks = []; this.size = 0; this.dropping = true;
        this.onError(new Error('Native frame exceeds size limit'));
      }
      if (!this.dropping && part.length) { this.chunks.push(part); this.size += part.length; }
      if (newline >= 0) {
        if (!this.dropping && this.size) {
          const line = Buffer.concat(this.chunks, this.size);
          try { this.onFrame(JSON.parse(line.toString('utf8'))); } catch (e) { this.onError(e); }
        }
        this.chunks = []; this.size = 0; this.dropping = false;
      }
      offset = end + 1;
    }
  }
}
