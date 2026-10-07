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
    const record: Specimen = { ...draft, id: newId('spm'), createdAt: Date.now() };
    await db.specimens.put(record);
    set({ items: [record, ...get().items] });
    return record;
  },
  async update(id, patch) {
    await db.specimens.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async setStatus(id, status) {
    await get().update(id, { status });
  },
  async remove(id) {
    await db.specimens.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
}));
