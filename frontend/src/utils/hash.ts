/**
 * 轻量内容指纹（FNV-1a 32 位）。
 * 仅用于离线留痕包的影像去重比对，不做密码学用途。
 */

/** 字符串 → 32 位 FNV-1a 十六进制 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // 32 位 FNV prime，用无符号乘模拟
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 影像内容指纹：dataUrl 原文（去首尾空白）哈希 */
export function photoContentHash(dataUrl: string): string {
  return `ph_${fnv1aHex((dataUrl ?? '').trim())}`;
}

/** UTF-8 字节长度（分批写入按字节估算包体容量） */
export function byteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  // 非浏览器环境兜底：按 UTF-8 编码逐字符估算
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}
