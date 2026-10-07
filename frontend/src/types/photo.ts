/** 影像阶段 */
export type PhotoStage = 'before' | 'after' | 'process';

export const PHOTO_STAGES: PhotoStage[] = ['before', 'after', 'process'];

export const PHOTO_STAGE_LABEL: Record<PhotoStage, string> = {
  before: '修复前',
  after: '修复后',
  process: '过程',
};

/** 修复影像条目（dataUrl 存 IndexedDB 独立表） */
export interface PrepPhoto {
  id: string;
  specimenId: string;
  procedureId: string;
  stage: PhotoStage;
  caption: string;
  dataUrl: string;
  capturedAt: number;
}

export type PrepPhotoDraft = Omit<PrepPhoto, 'id'>;

/** 生成一张内联 SVG 影像（无相机时作为留痕示意图，全部内容本地生成，不依赖网络） */
export function makeSketchDataUrl(label: string, tone: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
  <rect width="480" height="320" fill="${tone}"/>
  <ellipse cx="240" cy="170" rx="150" ry="80" fill="#8d7a5e" opacity="0.65"/>
  <path d="M110 180 q60 -55 130 -30 q70 25 130 -10" stroke="#4a3d2c" stroke-width="6" fill="none"/>
  <text x="16" y="34" font-size="20" fill="#fff8ea" font-family="sans-serif">${label}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
