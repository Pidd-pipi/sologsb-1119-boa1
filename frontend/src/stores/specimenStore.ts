import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { Specimen, SpecimenDraft, SpecimenStatus } from '../types/specimen';

interface SpecimenState {
  items: Specimen[];
  loading: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SpecimenDraft) => Promise<Specimen>;
  update: (id: string, patch: Partial<Specimen>) => Promise<void>;
  setStatus: (id: string, status: SpecimenStatus) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** 离线合并后整体刷新 */
  hydrate: (items: Specimen[]) => void;
}

function withBump(record: Specimen, patch: Partial<Specimen>): Specimen {
  return { ...record, ...patch, rev: record.rev + 1, updatedAt: Date.now() };
}

export const useSpecimenStore = create<SpecimenState>((set, get) => ({
  items: [],
  loading: false,
  loaded: false,
  async load() {
    set({ loading: true });
    const items = await db.specimens.orderBy('createdAt').reverse().toArray();
    set({ items, loading: false, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const record: Specimen = { ...draft, id: newId('spm'), createdAt: now, rev: 1, updatedAt: now };
    await db.specimens.put(record);
    set({ items: [record, ...get().items] });
    return record;
  },
  async update(id, patch) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    const next = withBump(target, patch);
    await db.specimens.put(next);
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
  },
  async setStatus(id, status) {
    await get().update(id, { status });
  },
  async remove(id) {
    await db.specimens.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  hydrate(items) {
    set({ items });
  },
}));
