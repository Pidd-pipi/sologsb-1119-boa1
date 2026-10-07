/** Dexie 事务回滚验证：合并中途失败 → 四张表回到导入前，可重新导入 */
import 'fake-indexeddb/auto';
import { db } from '../src/utils/db';
import { applyTracePackets, PacketValidationError } from '../src/utils/tracePacket';
import type { TracePacket } from '../src/types/trace';
import type { PrepProcedure } from '../src/types/procedure';
import type { SupplyLot } from '../src/types/supply';

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

function packet(procedures: unknown[], supplies: unknown[] = [], photos: unknown[] = []): TracePacket {
  return {
    magic: 'gbfossilprep/trace-packet',
    packetVersion: 1,
    batchId: 'rollback-batch',
    partIndex: 0,
    partCount: 1,
    schemaVersion: 3,
    source: '修复室',
    exportedAt: now,
    specimens: [],
    procedures: procedures as TracePacket['procedures'],
    supplies: supplies as TracePacket['supplies'],
    photos: photos as TracePacket['photos'],
  };
}

const baseProc: PrepProcedure = {
  id: 'p1',
  specimenId: 's1',
  stepType: '清修',
  nodeName: '粗清',
  seq: 1,
  tools: [],
  abrasive: '',
  adhesive: '',
  adhesiveConc: 0,
  durationMin: 60,
  tempC: 22,
  rh: 50,
  photoBeforeIds: [],
  photoAfterIds: [],
  operator: '甲',
  startedAt: now - day,
  state: 'pending',
  rev: 1,
  updatedAt: now - day,
  conflicts: [],
};

async function main() {
  // 初始库：1 工序 + 1 批次
  await db.procedures.put({ ...baseProc });
  const sup: SupplyLot = {
    id: 'sup1',
    name: 'B72',
    kind: '胶种',
    spec: '',
    lotNo: 'L1',
    qty: 4,
    unit: '瓶',
    openedAt: now - day,
    shelfLifeMonths: 12,
    lowThreshold: 1,
    issues: [],
    rev: 1,
    updatedAt: now - day,
  };
  await db.supplies.put(sup);

  console.log('A) 正常合并写入');
  const good = packet([{ ...baseProc, rev: 2, updatedAt: now, operator: '乙' }]);
  const r1 = await applyTracePackets([good]);
  assert(r1.report.counts.procedures.updated === 1, '工序并入');
  assert((await db.procedures.get('p1'))!.operator === '乙', '库里已是对方版');

  console.log('B) 坏包（分片不齐）在开事务前被拒，库不变');
  const bad = { ...packet([]), partCount: 2 };
  let threw = false;
  try {
    await applyTracePackets([bad]);
  } catch (e) {
    threw = e instanceof PacketValidationError;
  }
  assert(threw, '分片不齐被拒绝');
  assert((await db.procedures.get('p1'))!.operator === '乙', '拒绝后库数据未动');

  console.log('C) 事务内失败整体回滚（模拟影像表写入时磁盘/配额故障）');
  // 真实场景里 dataUrl 体积最大、最容易写失败（配额/磁盘）。
  // 在 photos.bulkPut 上注入故障：整个读写事务必须回滚 procedures/supplies 的已做改动。
  const failPacket = packet(
    [{ ...baseProc, rev: 3, updatedAt: now, operator: '丙' }],
    [{ ...sup, rev: 2, qty: 99 }],
    [
      {
        id: 'ph-bad',
        specimenId: 's1',
        procedureId: 'p1',
        stage: 'before',
        caption: 'bad',
        dataUrl: 'data:,x',
        capturedAt: now,
        contentHash: 'h',
        rev: 1,
        updatedAt: now,
      },
    ],
  );
  const photosTable = db.photos as unknown as { bulkPut: (...args: unknown[]) => Promise<unknown> };
  const originalBulkPut = photosTable.bulkPut.bind(photosTable);
  photosTable.bulkPut = async () => {
    throw new Error('simulated quota exceeded while writing photo blob');
  };
  threw = false;
  try {
    await applyTracePackets([failPacket]);
  } catch (e) {
    threw = true;
    console.log(`    （预期内失败：${(e as Error).message.slice(0, 60)}…）`);
  } finally {
    photosTable.bulkPut = originalBulkPut;
  }
  assert(threw, '坏影像导致合并抛错');
  const procAfter = await db.procedures.get('p1');
  const supAfter = await db.supplies.get('sup1');
  assert(procAfter!.operator === '乙' && procAfter!.rev === 2, '工序回滚到导入前（乙 / rev2）');
  assert(supAfter!.qty === 4, '材料余量回滚到导入前（4）');
  assert((await db.photos.count()) === 0, '影像表无残留');

  console.log('D) 回滚后可用修好的包重新导入');
  const retry = packet(
    [{ ...baseProc, rev: 3, updatedAt: now, operator: '丙' }],
    [{ ...sup, rev: 2, qty: 1 }],
    [
      {
        id: 'ph1',
        specimenId: 's1',
        procedureId: 'p1',
        stage: 'before',
        caption: 'ok',
        dataUrl: 'data:,x',
        capturedAt: now,
        contentHash: 'h',
        rev: 1,
        updatedAt: now,
      },
    ],
  );
  retry.batchId = 'rollback-batch-retry';
  const r2 = await applyTracePackets([retry]);
  assert(r2.report.counts.procedures.updated === 1, '重导成功');
  assert((await db.procedures.get('p1'))!.operator === '丙', '工序为重导后的丙版');
  assert((await db.supplies.get('sup1'))!.qty === 1, '余量为重导后的 1');
  assert((await db.photos.count()) === 1, '影像写入 1 条');

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`);
    process.exit(1);
  } else {
    console.log('\n事务回滚验证全部通过');
  }
}

void main();
