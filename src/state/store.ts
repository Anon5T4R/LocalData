// Estado central do LocalData.
//
// Diferente dos irmãos de "documento" (writer/slides), aqui NÃO existe estado
// sujo: cada mutação vira uma transação SQLite na hora. O store só espelha o
// banco (schema + registros carregados da view ativa) e orquestra os comandos.
//
// Registros são paginados: a primeira página chega rápido e as demais são
// puxadas em background (comandos Rust rodam fora da main thread), então
// tabelas grandes não travam a UI.
//
// Undo/redo (Ctrl+Z/Ctrl+Y) cobre operações de REGISTRO (editar/criar/excluir)
// com ops inversas; operações de schema (campos/tabelas) não entram — elas já
// pedem confirmação e conversões de tipo não são reversíveis com fidelidade.

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
const PAGE_SIZE = 500;
const UNDO_CAP = 100;

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

// --- ações de undo (ids/linhas são mutados após re-inserção pra manter os ciclos coerentes) ---

type UndoAction =
  | { type: "update"; tableId: string; before: { id: number; cells: Record<string, CellValue> }[]; after: { id: number; cells: Record<string, CellValue> }[] }
  | { type: "create"; tableId: string; ids: number[]; rows: Record<string, CellValue>[] }
  | { type: "delete"; tableId: string; rows: RecordRow[] };

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
  undoStack: UndoAction[];
  redoStack: UndoAction[];

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
  reorderTables(ids: string[]): Promise<void>;
  addField(name: string, type: FieldType, options: object): Promise<void>;
  updateField(fieldId: string, name?: string, options?: object): Promise<void>;
  changeFieldType(fieldId: string, type: FieldType, options?: object): Promise<void>;
  deleteField(fieldId: string): Promise<void>;
  reorderFields(ids: string[]): Promise<void>;
  addView(name: string, kind: ViewKind, config?: ViewConfig): Promise<void>;
  renameView(id: string, name: string): Promise<void>;
  deleteView(id: string): Promise<void>;
  patchViewConfig(patch: Partial<ViewConfig>): Promise<void>;

  // --- registros ---
  refreshRows(): Promise<void>;
  addRecord(cells?: Record<string, CellValue>): Promise<number | null>;
  duplicateRecord(recordId: number): Promise<number | null>;
  updateCell(recordId: number, fieldId: string, value: CellValue): Promise<void>;
  updateRecord(recordId: number, cells: Record<string, CellValue>): Promise<void>;
  deleteRecords(ids: number[]): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;

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

/** Só os campos com coluna real (fórmula é computada, não gravável). */
function writableCells(table: Table | undefined, cells: Record<string, CellValue>): Record<string, CellValue> {
  if (!table) return cells;
  const formulaIds = new Set(table.fields.filter((f) => f.type === "formula").map((f) => f.id));
  const out: Record<string, CellValue> = {};
  for (const [k, v] of Object.entries(cells)) if (!formulaIds.has(k)) out[k] = v;
  return out;
}

export const useStore = create<DataState>((set, get) => {
  // token de corrida: cada refresh invalida os carregamentos em background anteriores
  let fetchSeq = 0;

  /** roda uma ação, capturando o erro pro banner. */
  async function guard<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      set({ error: msg(e) });
      return null;
    }
  }

  function pushUndo(action: UndoAction) {
    set((s) => ({ undoStack: [...s.undoStack.slice(-UNDO_CAP + 1), action], redoStack: [] }));
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

  /** Carrega as páginas restantes em background até completar (ou o token virar). */
  async function loadRemainingPages(tableId: string, filters: FilterSpec[], sorts: SortSpec[], search: string | undefined, seq: number) {
    for (;;) {
      const st = get();
      if (seq !== fetchSeq || st.activeTableId !== tableId) return;
      if (st.rows.length >= st.total) return;
      try {
        const res = await api.recordsQuery(tableId, {
          filters,
          sorts,
          search,
          limit: PAGE_SIZE,
          offset: st.rows.length,
        });
        if (seq !== fetchSeq || get().activeTableId !== tableId) return;
        set((s) => ({ rows: [...s.rows, ...res.rows], total: res.total }));
        if (!res.rows.length) return; // segurança contra loop
      } catch (e) {
        if (seq === fetchSeq) set({ error: msg(e) });
        return;
      }
    }
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
    undoStack: [],
    redoStack: [],

    async createBase(path) {
      await guard(async () => {
        const schema = await api.baseCreate(path);
        pushRecent(path);
        const t = firstTable(schema);
        set({
          schema,
          activeTableId: t?.id ?? null,
          activeViewId: t?.views[0]?.id ?? null,
          search: "",
          undoStack: [],
          redoStack: [],
        });
        await get().refreshRows();
      });
    },

    async openBase(path) {
      await guard(async () => {
        const schema = await api.baseOpen(path);
        pushRecent(path);
        const t = firstTable(schema);
        set({
          schema,
          activeTableId: t?.id ?? null,
          activeViewId: t?.views[0]?.id ?? null,
          search: "",
          undoStack: [],
          redoStack: [],
        });
        await get().refreshRows();
      });
    },

    async closeBase() {
      fetchSeq++;
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
      set({
        schema: null,
        activeTableId: null,
        activeViewId: null,
        rows: [],
        total: 0,
        search: "",
        undoStack: [],
        redoStack: [],
      });
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
        // undo de registros da tabela morta não faz mais sentido
        set((s) => ({
          undoStack: s.undoStack.filter((a) => a.tableId !== id),
          redoStack: s.redoStack.filter((a) => a.tableId !== id),
        }));
        await reloadSchemaKeepingActive();
        await get().refreshRows();
      });
    },

    async reorderTables(ids) {
      await guard(async () => {
        await api.tablesReorder(ids);
        await reloadSchemaKeepingActive();
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
        // valores convertidos: o undo antigo poderia gravar dados no formato errado
        set({ undoStack: [], redoStack: [] });
        await reloadSchemaKeepingActive();
        await get().refreshRows();
      });
    },

    async deleteField(fieldId) {
      await guard(async () => {
        await api.fieldDelete(fieldId);
        set({ undoStack: [], redoStack: [] });
        await reloadSchemaKeepingActive();
        await get().refreshRows();
      });
    },

    async reorderFields(ids) {
      const tableId = get().activeTableId;
      if (!tableId) return;
      await guard(async () => {
        await api.fieldsReorder(tableId, ids);
        await reloadSchemaKeepingActive();
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
      const search = st.search || undefined;
      const seq = ++fetchSeq;
      set({ loading: true });
      try {
        const res = await api.recordsQuery(table.id, { filters, sorts, search, limit: PAGE_SIZE, offset: 0 });
        if (seq !== fetchSeq || get().activeTableId !== table.id) return;
        set({ rows: res.rows, total: res.total, loading: false });
        if (res.total > res.rows.length) {
          void loadRemainingPages(table.id, filters, sorts, search, seq);
        }
      } catch (e) {
        if (seq === fetchSeq) set({ error: msg(e), loading: false });
      }
    },

    async addRecord(cells = {}) {
      const st = get();
      const tableId = st.activeTableId;
      if (!tableId) return null;
      const clean = writableCells(activeTable(st), cells);
      const id = await guard(() => api.recordCreate(tableId, clean));
      if (id != null) {
        pushUndo({ type: "create", tableId, ids: [id], rows: [clean] });
      }
      await get().refreshRows();
      return id;
    },

    async duplicateRecord(recordId) {
      const st = get();
      const tableId = st.activeTableId;
      const row = st.rows.find((r) => r.id === recordId);
      if (!tableId || !row) return null;
      const clean = writableCells(activeTable(st), row.cells);
      const id = await guard(() => api.recordCreate(tableId, clean));
      if (id != null) {
        pushUndo({ type: "create", tableId, ids: [id], rows: [clean] });
      }
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
      const row = st.rows.find((r) => r.id === recordId);
      const before: Record<string, CellValue> = {};
      if (row) for (const k of Object.keys(cells)) before[k] = row.cells[k] ?? null;
      // otimista: aplica localmente já
      set({
        rows: st.rows.map((r) => (r.id === recordId ? { ...r, cells: { ...r.cells, ...cells } } : r)),
      });
      try {
        await api.recordsUpdate(tableId, [{ id: recordId, cells }]);
        if (row) {
          pushUndo({
            type: "update",
            tableId,
            before: [{ id: recordId, cells: before }],
            after: [{ id: recordId, cells }],
          });
        }
        // filtros/ordenação podem ter mudado o resultado — recarrega em silêncio
        void get().refreshRows();
      } catch (e) {
        set({ error: msg(e) });
        void get().refreshRows();
      }
    },

    async deleteRecords(ids) {
      const st = get();
      const tableId = st.activeTableId;
      if (!tableId) return;
      const idSet = new Set(ids);
      const removed = st.rows.filter((r) => idSet.has(r.id));
      const ok = await guard(async () => {
        await api.recordsDelete(tableId, ids);
        return true;
      });
      if (ok && removed.length) {
        pushUndo({ type: "delete", tableId, rows: removed.map((r) => ({ id: r.id, cells: { ...r.cells } })) });
      }
      await get().refreshRows();
    },

    async undo() {
      const st = get();
      const action = st.undoStack[st.undoStack.length - 1];
      if (!action) return;
      const ok = await guard(async () => {
        switch (action.type) {
          case "update":
            await api.recordsUpdate(action.tableId, action.before);
            break;
          case "create":
            await api.recordsDelete(action.tableId, action.ids);
            break;
          case "delete": {
            // restaura com os IDs ORIGINAIS: relações e histórico continuam válidos
            const table = get().schema?.tables.find((t) => t.id === action.tableId);
            await api.recordsRestore(
              action.tableId,
              action.rows.map((r) => ({ id: r.id, cells: writableCells(table, r.cells) }))
            );
            break;
          }
        }
        return true;
      });
      if (ok) {
        set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, action] }));
        await get().refreshRows();
      }
    },

    async redo() {
      const st = get();
      const action = st.redoStack[st.redoStack.length - 1];
      if (!action) return;
      const ok = await guard(async () => {
        switch (action.type) {
          case "update":
            await api.recordsUpdate(action.tableId, action.after);
            break;
          case "create": {
            // recria com os ids originais (nunca reciclados pelo AUTOINCREMENT)
            const table = get().schema?.tables.find((t) => t.id === action.tableId);
            await api.recordsRestore(
              action.tableId,
              action.ids.map((id, i) => ({ id, cells: writableCells(table, action.rows[i] ?? {}) }))
            );
            break;
          }
          case "delete":
            await api.recordsDelete(
              action.tableId,
              action.rows.map((r) => r.id)
            );
            break;
        }
        return true;
      });
      if (ok) {
        set((s) => ({ redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, action] }));
        await get().refreshRows();
      }
    },

    setError(e) {
      set({ error: e });
    },
  };
});
