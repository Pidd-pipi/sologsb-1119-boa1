/** 单位换算与文案工具：mm/inch、g/ct、莫氏硬度分级 */

export const MM_PER_INCH = 25.4;
export const CT_PER_G = 5;

export function mmToInch(mm: number): number {
  return round(mm / MM_PER_INCH, 3);
}

export function inchToMm(inch: number): number {
  return round(inch * MM_PER_INCH, 2);
}

export function gToCt(g: number): number {
  return round(g * CT_PER_G, 2);
}

export function ctToG(ct: number): number {
  return round(ct / CT_PER_G, 2);
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 莫氏硬度分级文案 */
export function hardnessLabel(value: number): { label: string; tone: 'soft' | 'medium' | 'hard' } {
  if (!Number.isFinite(value) || value <= 0) return { label: '未测', tone: 'soft' };
  if (value < 3) return { label: `莫氏 ${value} · 软质围岩`, tone: 'soft' };
  if (value < 6) return { label: `莫氏 ${value} · 中硬围岩`, tone: 'medium' };
  return { label: `莫氏 ${value} · 硬质围岩`, tone: 'hard' };
}

/** 测量字段的取值范围校验 */
export function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}
