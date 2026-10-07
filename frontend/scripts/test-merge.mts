/**
 * 合并引擎逻辑验证（Node 下直接用 tsx 不便装额外依赖，用极简脚本：
 * 通过 vite/esbuild 已安装的能力编译后运行）。
 */
import { mergeOfflinePacket } from '../src/utils/offlineMerge';
import {
  assertPacketNotStale,
  buildTracePackets,
  markLocalProceduresChanged,
  parseTracePacket,
  validatePacketSet,
  PacketStaleError,
  __setMarkerStoreForTest,
} from '../src/utils/tracePacket';
import { photoContentHash } from '../src/utils/hash';
import type { Specimen } from '../src/types/specimen';
import type { PrepProcedure, PrepProcedureRevision } from '../src/types/procedure';
import type { SupplyLot } from '../src/types/supply';
import type { PrepPhoto } from '../src/types/photo';
import { TRACE_PACKET_MAGIC, TRACE_PACKET_VERSION } from '../src/types/trace';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

const day = 24 * 3600 * 1000;
const now = Date.now();

function specimen(over: Partial<Specimen> = {}): Specimen {
  return {
    id: 's1',
    specimenNo: 'FP-001',
    taxon: 'T',
    horizon: 'H',
    locality: 'L',
    lithology: '岩',
    matrixHardness: 3,
    dimensions: '10x10x10',
    weight: 100,
    storageBox: 'A1',
    status: '修复中',
    createdAt: now - 5 * day,
    rev: 1,
    updatedAt: now - 5 * day,
    ...over,
  };
}

function procedure(over: Partial<PrepProcedureRevision> = {}): PrepProcedure {
  return {
    id: 'p1',
    specimenId: 's1',
    stepType: '清修',
    nodeName: '粗清',
    seq: 1,
    tools: ['剔针'],
    abrasive: '',
    adhesive: '',
    adhesiveConc: 0,
    durationMin: 60,
    tempC: 22,
    rh: 50,
    photoBeforeIds: [],
    photoAfterIds: [],
    operator: '甲',
    startedAt: now - 2 * day,
    state: 'pending',
    rev: 1,
    updatedAt: now - 2 * day,
    conflicts: [],
    ...over,
  } as PrepProcedure;
}

function photo(over: Partial<PrepPhoto> = {}): PrepPhoto {
  const dataUrl = over.dataUrl ?? 'data:image/svg+xml,aaa';
  return {
    id: 'ph1',
    specimenId: 's1',
    procedureId: 'p1',
    stage: 'before',
    caption: 'c',
    dataUrl,
    capturedAt: now - 2 * day,
    contentHash: photoContentHash(dataUrl),
    rev: 1,
    updatedAt: now - 2 * day,
    ...over,
  };
}

console.log('1) 仅一侧新改 → 直接并入（高修订号胜出）');
{
  const local = { specimens: [], procedures: [procedure()], supplies: [], photos: [] };
  const remote = {
    source: '修复室',
    batchId: 'b1',
    exportedAt: now,
    schemaVersion: 3,
    specimens: [],
    procedures: [procedure({ rev: 2, updatedAt: now - day, operator: '乙' })],
    supplies: [],
    photos: [],
  };
  const r = mergeOfflinePacket(local, remote);
  assert(r.procedures[0].operator === '乙', '高修订号的对方版直接并入');
  assert(r.procedures[0].conflicts.length === 0, '无待核分叉');
  assert(r.report.counts.procedures.updated === 1, '计数 updated=1');
}

console.log('2) 两边都动过（同 rev 不同内容）→ 留两版待核');
{
  const local = {
    specimens: [],
    procedures: [procedure({ rev: 3, updatedAt: now - day, operator: '本机改', durationMin: 80 })],
    supplies: [],
    photos: [],
  };
  const remote = {
    source: '修复室',
    batchId: 'b2',
    exportedAt: now,
    schemaVersion: 3,
    specimens: [],
    procedures: [procedure({ rev: 3, updatedAt: now - day, operator: '修复室改', durationMin: 90 })],
    supplies: [],
    photos: [],
  };
  const r = mergeOfflinePacket(local, remote);
  const p = r.procedures[0];
  assert(p.conflicts.filter((c) => c.status === 'pending').length === 2, '保留两版 pending');
  assert(p.conflicts.some((c) => c.side === 'local' && c.snapshot.operator === '本机改'), '本机版入待核');
  assert(p.conflicts.some((c) => c.side === 'remote' && c.snapshot.operator === '修复室改'), '留痕包版入待核');
  assert(p.operator === '本机改', '主记录暂留本机版');
  assert(p.rev === 4, '主记录修订号前进到 4');
  assert(r.report.conflicts.length === 1, '报告记录 1 个冲突');
}

console.log('3) 影像按拍摄时间/阶段归挂，重复只留一条');
{
  const proc = procedure({
    id: 'p1',
    startedAt: now - 2 * day,
    finishedAt: now - 2 * day + 60 * 60000,
  });
  // 本地已有一张修复前影像
  const localPhoto = photo({
    id: 'local-before',
    capturedAt: now - 2 * day - 10 * 60000,
    dataUrl: 'data:,localbefore',
  });
  const local = {
    specimens: [specimen()],
    procedures: [proc],
    supplies: [],
    photos: [localPhoto],
  };
  const dup = photo({
    id: 'remote-dup',
    capturedAt: localPhoto.capturedAt,
    dataUrl: localPhoto.dataUrl, // 同内容
  });
  const afterOnly = photo({
    id: 'remote-after',
    procedureId: '', // 故意未挂接
    stage: 'process' as PrepPhoto['stage'],
    capturedAt: now - 2 * day + 90 * 60000, // 工序结束之后
    dataUrl: 'data:,afteronly',
  });
  const remote = {
    source: '修复室',
    batchId: 'b3',
    exportedAt: now,
    schemaVersion: 3,
    specimens: [],
    procedures: [],
    supplies: [],
    photos: [dup, afterOnly],
  };
  const r = mergeOfflinePacket(local, remote);
  assert(r.photos.length === 2, `重复影像去重后只留 2 张（实际 ${r.photos.length}）`);
  assert(r.report.counts.photos.deduped === 1, 'deduped=1');
  const linked = r.photos.find((p) => p.id === 'remote-after')!;
  assert(linked.procedureId === 'p1', '孤儿影像按拍摄时间归到 p1');
  assert(linked.stage === 'after', '工序结束后的影像归为 after 阶段');
  const mergedProc = r.procedures[0];
  assert(mergedProc.photoAfterIds.includes('remote-after'), '工序修订的 afterIds 含新影像');
  assert(mergedProc.photoBeforeIds.includes('local-before'), 'beforeIds 保留本地影像');
  assert(mergedProc.rev === 2, '影像归挂导致工序修订号 +1');
}

console.log('4) 旧数据无修订号 → 按当前值回填 rev=1');
{
  const legacyProc: any = { ...procedure(), rev: undefined, updatedAt: undefined };
  delete legacyProc.rev;
  delete legacyProc.updatedAt;
  const local = { specimens: [], procedures: [], supplies: [], photos: [] };
  const remote = {
    source: '老修复室',
    batchId: 'b4',
    exportedAt: now,
    schemaVersion: 2,
    specimens: [],
    procedures: [legacyProc],
    supplies: [],
    photos: [],
  };
  const r = mergeOfflinePacket(local, remote);
  assert(r.procedures[0].rev === 1, '工序回填 rev=1');
  assert(
    r.report.warnings.some((w) => w.includes('回填')),
    '报告含回填说明',
  );
}

console.log('5) 合并后完成度与材料余量重算');
{
  const done = procedure({ id: 'p1', state: 'done', rev: 1 });
  const pending = procedure({ id: 'p2', seq: 2, state: 'pending', rev: 1 });
  const sup: SupplyLot = {
    id: 'sup1',
    name: 'B72',
    kind: '胶种',
    spec: '',
    lotNo: 'L1',
    qty: 3,
    unit: '瓶',
    openedAt: now - day,
    shelfLifeMonths: 12,
    lowThreshold: 2,
    issues: [],
    rev: 1,
    updatedAt: now - day,
  };
  const local = { specimens: [specimen()], procedures: [done, pending], supplies: [sup], photos: [] };
  const remoteSup: SupplyLot = { ...sup, qty: 2, rev: 2, updatedAt: now };
  const remote = {
    source: '修复室',
    batchId: 'b5',
    exportedAt: now,
    schemaVersion: 3,
    specimens: [],
    procedures: [],
    supplies: [remoteSup],
    photos: [],
  };
  const r = mergeOfflinePacket(local, remote);
  const prog = r.report.progressBySpecimen['s1'];
  assert(prog.total === 2 && prog.done === 1 && prog.percent === 50, `完成度重算 1/2=50%（实际 ${prog.done}/${prog.total}=${prog.percent}%）`);
  assert(r.report.supplyBalance['sup1'].qty === 2, '材料余量取新值 2');
  assert(r.report.supplyBalance['sup1'].low === true, '余量 2 ≤ 阈值 2 标记低量');
  assert(r.report.compareNotes.length === 1, '生成 1 段对照说明');
}

console.log('6) 分批写入：超容量自动拆片，分片可重组校验');
{
  const bigPng = 'data:image/png;base64,' + 'x'.repeat(5000);
  const photos = [1, 2, 3].map((i) =>
    photo({ id: `big${i}`, dataUrl: `${bigPng}${i}`, capturedAt: now - i * 60000 }),
  );
  const bundle = buildTracePackets(
    { specimens: [specimen()], procedures: [procedure()], supplies: [], photos },
    { source: '测试', schemaVersion: 3, maxBytes: 6000, now },
  );
  assert(bundle.files.length === 3, `按容量拆为 3 片（实际 ${bundle.files.length}）`);
  const parsed = bundle.files.map((f) => parseTracePacket(f.content));
  assert(parsed.every((p) => p.partCount === 3), 'partCount=3');
  const ordered = validatePacketSet(parsed);
  assert(ordered[0].partIndex === 0 && ordered[2].partIndex === 2, '分片按序重组');
  assert(ordered[0].specimens.length === 1, '非影像数据在第 0 片');
  assert(ordered.slice(1).every((p) => p.specimens.length === 0), '后续片只有影像');
}

console.log('7) 分片校验：缺片 / 混批 / 坏标识都应报错');
{
  const mk = (partIndex: number, partCount: number, batchId = 'bx'): any => ({
    magic: TRACE_PACKET_MAGIC,
    packetVersion: TRACE_PACKET_VERSION,
    batchId,
    partIndex,
    partCount,
    schemaVersion: 3,
    source: 't',
    exportedAt: now,
    specimens: [],
    procedures: [],
    supplies: [],
    photos: [],
  });
  let threw = false;
  try {
    validatePacketSet([mk(0, 2)]); // 缺第 2 片
  } catch {
    threw = true;
  }
  assert(threw, '缺片报错');
  threw = false;
  try {
    validatePacketSet([mk(0, 1, 'a'), mk(0, 1, 'b')]);
  } catch {
    threw = true;
  }
  assert(threw, '混批报错');
  threw = false;
  try {
    parseTracePacket(JSON.stringify({ magic: 'other' }));
  } catch {
    threw = true;
  }
  assert(threw, '坏标识报错');
}

console.log('8) 本机工序改动后旧留痕包失效，新包可导入');
{
  const map = new Map<string, string>();
  __setMarkerStoreForTest({
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  });
  const mkPacket = (exportedAt: number) => ({
    magic: TRACE_PACKET_MAGIC,
    packetVersion: TRACE_PACKET_VERSION,
    batchId: 'stale-batch',
    partIndex: 0,
    partCount: 1,
    schemaVersion: 3,
    source: '修复室',
    exportedAt,
    specimens: [],
    procedures: [],
    supplies: [],
    photos: [],
  });

  // 改动前导出的旧包：放行
  const oldPacket = mkPacket(now - 3 * day);
  let stale = false;
  try {
    assertPacketNotStale(oldPacket as never);
  } catch (e) {
    stale = e instanceof PacketStaleError;
  }
  assert(!stale, '本机未改动时旧包不拦');

  // 本机工序在 now-day 改动
  markLocalProceduresChanged(now - day);
  stale = false;
  try {
    assertPacketNotStale(oldPacket as never);
  } catch (e) {
    stale = e instanceof PacketStaleError;
  }
  assert(stale, '导出早于本机改动点的旧包被拒绝');

  stale = false;
  try {
    assertPacketNotStale(mkPacket(now) as never);
  } catch (e) {
    stale = e instanceof PacketStaleError;
  }
  assert(!stale, '改动后重新导出的新包放行');
  __setMarkerStoreForTest(null);
}

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`);
  process.exit(1);
} else {
  console.log('\n全部断言通过');
}
