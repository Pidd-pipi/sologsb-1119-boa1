import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { markLocalProceduresChanged } from '../utils/tracePacket';
import type { PrepProcedure, PrepProcedureDraft, ProcedureConflict } from '../types/procedure';

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PrepProcedureDraft) => Promise<PrepProcedure>;
  finish: (id: string) => Promise<void>;
  rollback: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** 两版待核裁决：side 为核定保留的一版，另一版标记舍弃 */
  resolveConflict: (id: string, side: 'local' | 'remote') => Promise<void>;
  /** 离线合并后用库内结果整体刷新 */
  hydrate: (items: PrepProcedure[]) => void;
  bySpecimen: (specimenId: string) => PrepProcedure[];
}

function sortItems(items: PrepProcedure[]): PrepProcedure[] {
  return [...items].sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
}

/** 本机工序发生改动：旧留痕包即刻失效 */
function markDirty(): void {
  markLocalProceduresChanged();
}

export const useProcedureStore = create<ProcedureState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = sortItems(await db.procedures.toArray());
    set({ items, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const record: PrepProcedure = { ...draft, id: newId('prc'), rev: 1, updatedAt: now, conflicts: [] };
    await db.procedures.put(record);
    markDirty();
    set({ items: sortItems([...get().items, record]) });
    return record;
  },
  async finish(id) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    const now = Date.now();
    const next: PrepProcedure = {
      ...target,
      state: 'done',
      finishedAt: now,
      rev: target.rev + 1,
      updatedAt: now,
    };
    await db.procedures.put(next);
    markDirty();
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
  },
  async rollback(id) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    const now = Date.now();
    const next: PrepProcedure = {
      ...target,
      state: 'rolledback',
      finishedAt: undefined,
      rev: target.rev + 1,
      updatedAt: now,
    };
    await db.procedures.put(next);
    markDirty();
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
  },
  async remove(id) {
    await db.procedures.delete(id);
    markDirty();
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  async resolveConflict(id, side) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    const pending = (target.conflicts ?? []).filter((c) => c.status === 'pending');
    const kept = pending.find((c) => c.side === side);
    if (!kept) return;
    const now = Date.now();
    const history: ProcedureConflict[] = (target.conflicts ?? []).map((c) => {
      if (c.status !== 'pending') return c;
      return c.side === side ? { ...c, status: 'kept' } : { ...c, status: 'discarded' };
    });
    // 以核定版为准，保留主记录当前影像挂接结果，并自增修订号
    const next: PrepProcedure = {
      ...kept.snapshot,
      photoBeforeIds: target.photoBeforeIds,
      photoAfterIds: target.photoAfterIds,
      rev: target.rev + 1,
      updatedAt: now,
      conflicts: history,
    };
    await db.procedures.put(next);
    markDirty();
    set({ items: sortItems(get().items.map((it) => (it.id === id ? next : it))) });
  },
  hydrate(items) {
    set({ items: sortItems(items) });
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
