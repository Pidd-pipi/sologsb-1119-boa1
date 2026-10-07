/** 离线留痕包：合作修复室处理完标本后送回，馆内据此离线合并 */
import type { Specimen } from './specimen';
import type { PrepProcedure } from './procedure';
import type { SupplyLot } from './supply';
import type { PrepPhoto } from './photo';

/** 留痕包格式版本 */
export const PACKET_FORMAT = 'gbfossilprep:trace-packet';
export const PACKET_FORMAT_VERSION = 1;

export interface SyncDevice {
  /** museum=馆内（本机） / coop=合作修复室 */
  side: 'museum' | 'coop';
  /** 设备/机构名，仅作展示 */
  name: string;
}

/** 数据包单卷（超容量时整包分批写入，每卷可独立校验） */
export interface SyncPacketPart {
  format: typeof PACKET_FORMAT;
  formatVersion: number;
  /** 同一导出任务内各卷共享 */
  batchId: string;
  /** 从 1 开始 */
  index: number;
  /** 总卷数 */
  total: number;
  specimens: Specimen[];
  procedures: PrepProcedure[];
  supplies: SupplyLot[];
  photos: PrepPhoto[];
  /** 整包范围的 sha-256 文本（sha-256 不可用时回退 FNV-1a），用于逐卷完整性校验 */
  checksum: string;
  exportedAt: number;
  exporter: SyncDevice;
}

/** 合并结果（供页面展示与对照说明引用） */
export interface MergeReport {
  importedAt: number;
  packetBatchId: string;
  packetExportedAt: number;
  /** 直接并入的标本数 */
  specimensAdded: number;
  specimensUpdated: number;
  /** 工序：单侧新改直接并入 */
  proceduresAdded: number;
  proceduresUpdated: number;
  /** 两边都动过 → 留两版待核的工序数（每处 2 行） */
  conflictsCreated: number;
  /** 已存在的待核分组被本次回包刷新覆盖的数量 */
  conflictsRefreshed: number;
  /** 回包内容与馆内版一致、自动核定撤销待核的数量 */
  conflictsResolved: number;
  /** 旧留痕包（导出早于本机最近工序改动）被拦截为待核的数量 */
  staleTakeoversBlocked: number;
  /** 影像：新挂接条数 / 重复去重条数 */
  photosAdded: number;
  photosDeduped: number;
  /** 材料批次：并入数 / 更新数 / 领用明细合并条数 */
  suppliesAdded: number;
  suppliesUpdated: number;
  supplyIssuesMerged: number;
  /** 本次涉及的标本（用于重算完成度提示与对照说明） */
  touchedSpecimenIds: string[];
  conflictIds: string[];
  notes: string[];
}
