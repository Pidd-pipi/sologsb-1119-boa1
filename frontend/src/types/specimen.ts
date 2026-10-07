/** 修订留痕：所有可离线合并的记录都携带修订号与最近改动时间 */
export interface RevisionTracked {
  /** 修订号，每次改动自增；旧数据无修订号时按当前值回填为 1 */
  rev: number;
  /** 最近改动时间（ms 时间戳） */
  updatedAt: number;
}

/** 标本状态 */
export type SpecimenStatus = '待清修' | '修复中' | '已加固' | '待交付' | '已交付';

export const SPECIMEN_STATUSES: SpecimenStatus[] = [
  '待清修',
  '修复中',
  '已加固',
  '待交付',
  '已交付',
];

/** 化石标本 */
export interface Specimen {
  id: string;
  /** 标本号 */
  specimenNo: string;
  /** 分类鉴定 */
  taxon: string;
  /** 层位 */
  horizon: string;
  /** 产地 */
  locality: string;
  /** 围岩岩性 */
  lithology: string;
  /** 围岩莫氏硬度 */
  matrixHardness: number;
  /** 尺寸 mm，形如 210×140×60 */
  dimensions: string;
  /** 重量 g */
  weight: number;
  /** 匣位 */
  storageBox: string;
  status: SpecimenStatus;
  createdAt: number;
  rev: number;
  updatedAt: number;
}

export type SpecimenDraft = Omit<Specimen, 'id' | 'createdAt' | 'rev' | 'updatedAt'>;
