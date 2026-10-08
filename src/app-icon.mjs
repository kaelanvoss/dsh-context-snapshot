export const MAX_APP_ICON_BYTES = 8 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A small local PNG only. Icons never accept URLs, SVG, paths or commands. */
export function cleanAppIcon(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_APP_ICON_BYTES / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  let decoded;
  try { decoded = atob(value); } catch { return undefined; }
  if (decoded.length < 33 || decoded.length > MAX_APP_ICON_BYTES || btoa(decoded) !== value) return undefined;
  if (PNG_SIGNATURE.some((byte, index) => decoded.charCodeAt(index) !== byte) || decoded.slice(12, 16) !== 'IHDR') return undefined;
  const uint32 = offset => ((decoded.charCodeAt(offset) * 0x1000000) + (decoded.charCodeAt(offset + 1) << 16) + (decoded.charCodeAt(offset + 2) << 8) + decoded.charCodeAt(offset + 3));
  const width = uint32(16), height = uint32(20);
  return width > 0 && height > 0 && width <= 128 && height <= 128 ? value : undefined;
}
