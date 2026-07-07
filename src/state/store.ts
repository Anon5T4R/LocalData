// Estado central do LocalData.
//
// Diferente dos irmãos de "documento" (writer/slides), aqui NÃO existe estado
// sujo: cada mutação vira uma transação SQLite na hora. O store só espelha o
// banco (schema + página de registros da view ativa) e orquestra os comandos.

import { create } from "zustand";
import * as api from "../lib/backend";
import type {
  BaseSchema,
  CellValue,
  Field,
  FieldType,
  FilterSpec,
  RecordRow,
  SortSpec,
  Table,
  View,
  ViewConfig,
  ViewKind,
} from "../lib/types";

const RECENTS_KEY = "localdata.recents";

export function readRecents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function pushRecent(path: string) {
  const list = [path, ...readRecents().filter((p) => p !== path)].slice(0, 12);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
}

export function dropRecent(path: string) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(readRecents().filter((p) => p !== path)));
}

interface DataState {
  schema: BaseSchema | null;
  activeTableId: string | null;
  activeViewId: string | null;
  rows: RecordRow[];
  total: number;
  loading: boolean;
  error: string | null;
  search: string;
  /** registro aberto no modal (id) ou "new" */
  openRecordId: number | "new" | null;

  // --- base ---
  createBase(path: string): Promise<void>;
  openBase(path: string): Promise<void>;
  closeBase(): Promise<void>;
  refreshSchema(): Promise<void>;

  // --- navegação ---
  setActiveTable(id: string): void;
  setActiveView(id: string): void;
  setSearch(q: string): void;
  setOpenRecord(id: number | "new" | null): void;

  // --- tabelas/campos/views ---
  addTable(name: string): Promise<void>;
  renameTable(id: string, name: string): Promise<void>;
  deleteTable(id: string): Promise<void>;
  addField(name: string, type: FieldType, options: object): Promise<void>;
  updateField(fieldId: string, name?: string, options?: object): Promise<void>;
  changeFieldType(fieldId: string, type: FieldType, options?: object): Promise<void>;
  deleteField(fieldId: string): Promise<void>;
  addView(name: string, kind: ViewKind, config?: ViewConfig): Promise<void>;
  renameView(id: string, name: string): Promise<void>;
  deleteView(id: string): Promise<void>;
  patchViewConfig(patch: Partial<ViewConfig>): Promise<void>;

  // --- registros ---
  refreshRows(): Promise<void>;
  addRecord(cells?: Record<string, CellValue>): Promise<number | null>;
  updateCell(recordId: number, fieldId: string, value: CellValue): Promise<void>;
  updateRecord(recordId: number, cells: Record<string, CellValue>): Promise<void>;
  deleteRecords(ids: number[]): Promise<void>;

  setError(e: string | null): void;
}

function firstTable(schema: BaseSchema | null): Table | undefined {
  return schema?.tables[0];
}

export function activeTable(s: { schema: BaseSchema | null; activeTableId: string | null }): Table | undefined {
  return s.schema?.tables.find((t) => t.id === s.activeTableId);
}

export function activeView(s: {
  schema: BaseSchema | null;
  activeTableId: string | null;
  activeViewId: string | null;
}): View | undefined {
  return activeTable(s)?.views.find((v) => v.id === s.activeViewId);
}

/** Campos visíveis da view ativa, na ordem. */
export function visibleFields(table: Table | undefined, view: View | undefined): Field[] {
  if (!table) return [];
  const hidden = new Set(view?.config.hiddenFields ?? []);
  return table.fields.filter((f) => !hidden.has(f.id));
}

function msg(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export const useStore = create<DataState>((set, get) => {
  /** roda uma ação, capturando o erro pro banner. */
  async function guard<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      set({ error: msg(e) });
      return null;
    }
  }

  async function reloadSchemaKeepingActive() {
    const schema = await api.baseSchema();
    const st = get();
    let tableId = st.activeTableId;
    if (!schema.tables.some((t) => t.id === tableId)) tableId = schema.tables[0]?.id ?? null;
    const table = schema.tables.find((t) => t.id === tableId);
    let viewId = st.activeViewId;
    if (!table?.views.some((v) => v.id === viewId)) viewId = table?.views[0]?.id ?? null;
    set({ schema, activeTableId: tableId, activeViewId: viewId });
  }

  return {
    schema: null,
    activeTableId: null,
    activeViewId: null,
    rows: [],
    total: 0,
    loading: false,
    error: null,
    search: "",
    openRecordId: null,

    async createBase(path) {
      await guard(async () => {
        const schema = await api.baseCreate(path);
        pushRecent(path);
        const t = firstTable(schema);
        set({ schema, activeTableId: t?.id ?? null, activeViewId: t?.views[0]?.id ?? null, search: "" });
        await get().refreshRows();
      });
    },

    async openBase(path) {
      await guard(async () => {
        const schema = await api.baseOpen(path);
        pushRecent(path);
        const t = firstTable(schema);
        set({ schema, activeTableId: t?.id ?? null, activeViewId: t?.views[0]?.id ?? null, search: "" });
        await get().refreshRows();
      });
    },

    async closeBase() {
      try {
        await api.attachmentsGc();
      } catch {
        /* melhor esforço */
      }
      try {
        await api.baseClose();
      } catch {
        /* já fechada */
      }
      set({ schema: null, activeTableId: null, activeViewId: null, rows: [], total: 0, search: "" });
    },

    async refreshSchema() {
      await guard(reloadSchemaKeepingActive);
    },

    setActiveTable(id) {
      const table = get().schema?.tables.find((t) => t.id === id);
      set({ activeTableId: id, activeViewId: table?.views[0]?.id ?? null, search: "", rows: [], total: 0 });
      void get().refreshRows();
    },

    setActiveView(id) {
      set({ activeViewId: id });
      void get().refreshRows();
    },

    setSearch(q) {
      set({ search: q });
      void get().refreshRows();
    },

    setOpenRecord(id) {
      set({ openRecordId: id });
    },

    async addTable(name) {
      await guard(async () => {
        const id = await api.tableCreate(name);
        await reloadSchemaKeepingActive();
        get().setActiveTable(id);
      });
    },

    async renameTable(id, name) {
      await guard(async () => {
        await api.tableRename(id, name);
        await reloadSchemaKeepingActive();
      });
    },

    async deleteTable(id) {
      await guard(async () => {
        await api.tableDelete(id);
        await reloadSchemaKeepingActive();
        await get().refreshRows();
      });
    },

    async addField(name, type, options) {
      const tableId = get().activeTableId;
      if (!tableId) return;
      await guard(async () => {
        await api.fieldCreate(tableId, name, type, options);
        await reloadSchemaKeepingActive();
        await get().refreshRows();
      });
    },

    async updateField(fieldId, name, options) {
      await guard(async () => {
        await api.fieldUpdate(fieldId, name, options);
        await reloadSchemaKeepingActive();
      });
    },

    async changeFieldType(fieldId, type, options) {
      await guard(async () => {
        await api.fieldChangeType(fieldId, type, options);
        await reloadSchemaKeepingActive();
        await get().refreshRows();
      });
    },

    async deleteField(fieldId) {
      await guard(async () => {
        await api.fieldDelete(fieldId);
        await reloadSchemaKeepingActive();
        await get().refreshRows();
      });
    },

    async addView(name, kind, config = {}) {
      const tableId = get().activeTableId;
      if (!tableId) return;
      await guard(async () => {
        const id = await api.viewCreate(tableId, name, kind, config);
        await reloadSchemaKeepingActive();
        set({ activeViewId: id });
        await get().refreshRows();
      });
    },

    async renameView(id, name) {
      await guard(async () => {
        await api.viewUpdate(id, name);
        await reloadSchemaKeepingActive();
      });
    },

    async deleteView(id) {
      await guard(async () => {
        await api.viewDelete(id);
        await reloadSchemaKeepingActive();
        await get().refreshRows();
      });
    },

    async patchViewConfig(patch) {
      const st = get();
      const view = activeView(st);
      if (!view) return;
      const config: ViewConfig = { ...view.config, ...patch };
      // otimista: atualiza o schema local antes do round-trip
      set({
        schema: st.schema && {
          ...st.schema,
          tables: st.schema.tables.map((t) =>
            t.id !== st.activeTableId
              ? t
              : { ...t, views: t.views.map((v) => (v.id === view.id ? { ...v, config } : v)) }
          ),
        },
      });
      await guard(async () => {
        await api.viewUpdate(view.id, undefined, config);
      });
      await get().refreshRows();
    },

    async refreshRows() {
      const st = get();
      const table = activeTable(st);
      if (!table) {
        set({ rows: [], total: 0 });
        return;
      }
      const view = activeView(st);
      const filters: FilterSpec[] = view?.config.filters ?? [];
      const sorts: SortSpec[] = view?.config.sorts ?? [];
      set({ loading: true });
      try {
        const res = await api.recordsQuery(table.id, {
          filters,
          sorts,
          search: st.search || undefined,
        });
        // se o usuário trocou de tabela no meio do fetch, descarta
        if (get().activeTableId === table.id) {
          set({ rows: res.rows, total: res.total, loading: false });
        }
      } catch (e) {
        set({ error: msg(e), loading: false });
      }
    },

    async addRecord(cells = {}) {
      const tableId = get().activeTableId;
      if (!tableId) return null;
      const id = await guard(() => api.recordCreate(tableId, cells));
      await get().refreshRows();
      return id;
    },

    async updateCell(recordId, fieldId, value) {
      await get().updateRecord(recordId, { [fieldId]: value });
    },

    async updateRecord(recordId, cells) {
      const st = get();
      const tableId = st.activeTableId;
      if (!tableId) return;
      // otimista: aplica localmente já
      set({
        rows: st.rows.map((r) => (r.id === recordId ? { ...r, cells: { ...r.cells, ...cells } } : r)),
      });
      try {
        await api.recordsUpdate(tableId, [{ id: recordId, cells }]);
        // filtros/ordenação podem ter mudado o resultado — recarrega em silêncio
        void get().refreshRows();
      } catch (e) {
        set({ error: msg(e) });
        void get().refreshRows();
      }
    },

    async deleteRecords(ids) {
      const tableId = get().activeTableId;
      if (!tableId) return;
      await guard(() => api.recordsDelete(tableId, ids));
      await get().refreshRows();
    },

    setError(e) {
      set({ error: e });
    },
  };
});
