// Wrappers dos comandos Rust (Tauri v2: chaves camelCase no invoke).

import { invoke } from "@tauri-apps/api/core";
import type {
  AttachmentMeta,
  BaseSchema,
  CellValue,
  FilterSpec,
  RecordRow,
  SortSpec,
  ViewConfig,
  ViewKind,
} from "./types";

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// --- base ---
export const baseCreate = (path: string) => invoke<BaseSchema>("base_create", { path });
export const baseOpen = (path: string) => invoke<BaseSchema>("base_open", { path });
export const baseClose = () => invoke<void>("base_close");
export const baseSchema = () => invoke<BaseSchema>("base_schema");
export const getStartupFile = () => invoke<string | null>("get_startup_file");

// --- tabelas ---
export const tableCreate = (name: string) => invoke<string>("table_create", { name });
export const tableRename = (tableId: string, name: string) => invoke<void>("table_rename", { tableId, name });
export const tableDelete = (tableId: string) => invoke<void>("table_delete", { tableId });
export const tableDuplicate = (tableId: string) => invoke<string>("table_duplicate", { tableId });
export const tablesReorder = (ids: string[]) => invoke<void>("tables_reorder", { ids });

// --- campos ---
export const fieldCreate = (tableId: string, name: string, fieldType: string, options: object) =>
  invoke<string>("field_create", { tableId, name, fieldType, options });
export const fieldUpdate = (fieldId: string, name?: string, options?: object) =>
  invoke<void>("field_update", { fieldId, name: name ?? null, options: options ?? null });
export const fieldChangeType = (fieldId: string, fieldType: string, options?: object) =>
  invoke<object>("field_change_type", { fieldId, fieldType, options: options ?? null });
export const fieldDelete = (fieldId: string) => invoke<void>("field_delete", { fieldId });
export const fieldDuplicate = (fieldId: string) => invoke<string>("field_duplicate", { fieldId });
export const fieldsReorder = (tableId: string, ids: string[]) => invoke<void>("fields_reorder", { tableId, ids });

// --- registros ---
export interface QueryResult {
  rows: RecordRow[];
  total: number;
}
export const recordsQuery = (
  tableId: string,
  opts: { filters?: FilterSpec[]; sorts?: SortSpec[]; search?: string; limit?: number; offset?: number } = {}
) =>
  invoke<QueryResult>("records_query", {
    tableId,
    filters: opts.filters ?? [],
    sorts: opts.sorts ?? [],
    search: opts.search ?? null,
    limit: opts.limit ?? null,
    offset: opts.offset ?? null,
  });
export const recordsByIds = (tableId: string, ids: number[]) =>
  invoke<RecordRow[]>("records_by_ids", { tableId, ids });
export const recordCreate = (tableId: string, cells: Record<string, CellValue>) =>
  invoke<number>("record_create", { tableId, cells });
export const recordsUpdate = (tableId: string, updates: { id: number; cells: Record<string, CellValue> }[]) =>
  invoke<void>("records_update", { tableId, updates });
export const recordsDelete = (tableId: string, ids: number[]) => invoke<void>("records_delete", { tableId, ids });
export const recordsInsertBulk = (tableId: string, rows: Record<string, CellValue>[]) =>
  invoke<number[]>("records_insert_bulk", { tableId, rows });
export const recordsRestore = (tableId: string, rows: { id: number; cells: Record<string, CellValue> }[]) =>
  invoke<void>("records_restore", { tableId, rows });

// --- views ---
export const viewCreate = (tableId: string, name: string, kind: ViewKind, config: ViewConfig) =>
  invoke<string>("view_create", { tableId, name, kind, config });
export const viewUpdate = (viewId: string, name?: string, config?: ViewConfig) =>
  invoke<void>("view_update", { viewId, name: name ?? null, config: config ?? null });
export const viewDuplicate = (viewId: string) => invoke<string>("view_duplicate", { viewId });
export const viewDelete = (viewId: string) => invoke<void>("view_delete", { viewId });

// --- anexos ---
export const attachmentImport = (paths: string[]) => invoke<AttachmentMeta[]>("attachment_import", { paths });
export const attachmentRead = (id: string) => invoke<string>("attachment_read", { id });
export const attachmentMetas = (ids: string[]) => invoke<AttachmentMeta[]>("attachment_metas", { ids });
export const attachmentsGc = () => invoke<number>("attachments_gc");
