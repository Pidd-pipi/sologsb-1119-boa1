import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { touchLocalProcEdit } from '../utils/sync/merge';
import type { PrepProcedure, PrepProcedureDraft } from '../types/procedure';

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PrepProcedureDraft) => Promise<PrepProcedure>;
  finish: (id: string) => Promise<void>;
  rollback: (id: string, reason?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bySpecimen: (specimenId: string) => PrepProcedure[];
}

/** 本机工序业务改动：修订号 +1、记修订时间，并使旧留痕包失效 */
function nextRev(row: PrepProcedure | undefined): number {
  return (row?.rev ?? 1) + 1;
}

export const useProcedureStore = create<ProcedureState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.procedures.toArray();
    items.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
    set({ items, loaded: true });
  },
  async add(draft) {
    const record: PrepProcedure = { ...draft, id: newId('prc'), rev: 1, updatedAt: Date.now() };
    await db.procedures.put(record);
    await touchLocalProcEdit();
    set({ items: [...get().items, record] });
    return record;
  },
  async finish(id) {
    const prev = get().items.find((it) => it.id === id);
    const patch: Partial<PrepProcedure> = {
      state: 'done',
      finishedAt: Date.now(),
      rev: nextRev(prev),
      updatedAt: Date.now(),
    };
    await db.procedures.update(id, patch);
    await touchLocalProcEdit();
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async rollback(id) {
    const prev = get().items.find((it) => it.id === id);
    const patch: Partial<PrepProcedure> = {
      state: 'rolledback',
      finishedAt: undefined,
      rev: nextRev(prev),
      updatedAt: Date.now(),
    };
    await db.procedures.update(id, patch);
    await touchLocalProcEdit();
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async remove(id) {
    await db.procedures.delete(id);
    await touchLocalProcEdit();
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
