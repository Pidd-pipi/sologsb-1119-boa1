/**
 * 留痕包内容指纹：优先用 WebCrypto SHA-256；
 * 非安全上下文（http、file:// 等）下回退到 FNV-1a，保证离线可用。
 */

export type HashAlgo = 'sha-256' | 'fnv1a';

const encoder = new TextEncoder();

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 32 位无符号 FNV 素数乘法
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export async function digestText(text: string): Promise<{ hex: string; algo: HashAlgo }> {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.subtle) {
    try {
      const buf = await cryptoObj.subtle.digest('SHA-256', encoder.encode(text));
      const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
      return { hex: `sha256:${hex}`, algo: 'sha-256' };
    } catch {
      /* 某些环境下 subtle 存在但不可用，落到 FNV */
    }
  }
  return { hex: `fnv1a:${fnv1a(text)}`, algo: 'fnv1a' };
}

/** 快速非密码指纹，仅用于体积预估失败后的兜底分卷判断 */
export function fnv1aHex(text: string): string {
  return fnv1a(text);
}
