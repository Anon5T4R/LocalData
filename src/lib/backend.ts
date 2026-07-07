// Wrappers dos comandos Rust (Tauri v2: chaves camelCase no invoke).
//
// Transporte: `call` roteia entre o backend LOCAL (invoke) e um host REMOTO
// (fetch, ver remote.ts) — os comandos de dados/schema funcionam igual nos
// dois. Comandos que só fazem sentido localmente (abrir arquivo, servir,
// extensões, backups, IA) usam `invoke` direto.

import { invoke } from "@tauri-apps/api/core";
import { isRemote, remoteCall } from "./remote";
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

/** Comando compartilhado: vai pro host remoto se conectado, senão local. */
function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return isRemote() ? remoteCall<T>(cmd, args) : invoke<T>(cmd, args);
}

// --- base (local; abrir/criar arquivo é sempre da máquina) ---
export const baseCreate = (path: string) => invoke<BaseSchema>("base_create", { path });
export const baseOpen = (path: string, backupKeep?: number) =>
  invoke<BaseSchema>("base_open", { path, backupKeep: backupKeep ?? null });
export const baseClose = () => invoke<void>("base_close");
export const baseSchema = () => call<BaseSchema>("base_schema");
export const getStartupFile = () => invoke<string | null>("get_startup_file");

// --- mudanças (polling) ---
export interface Changes {
  seq: number;
  schemaChanged: boolean;
  tables: string[];
}
export const changesSince = (since: number) => call<Changes>("changes_since", { since });

// --- tabelas ---
export const tableCreate = (name: string) => call<string>("table_create", { name });
export const tableRename = (tableId: string, name: string) => call<void>("table_rename", { tableId, name });
export const tableDelete = (tableId: string) => call<void>("table_delete", { tableId });
export const tableDuplicate = (tableId: string) => call<string>("table_duplicate", { tableId });
export const tablesReorder = (ids: string[]) => call<void>("tables_reorder", { ids });

// --- campos ---
export const fieldCreate = (tableId: string, name: string, fieldType: string, options: object) =>
  call<string>("field_create", { tableId, name, fieldType, options });
export const fieldUpdate = (fieldId: string, name?: string, options?: object) =>
  call<void>("field_update", { fieldId, name: name ?? null, options: options ?? null });
export const fieldChangeType = (fieldId: string, fieldType: string, options?: object) =>
  call<object>("field_change_type", { fieldId, fieldType, options: options ?? null });
export const fieldDelete = (fieldId: string) => call<void>("field_delete", { fieldId });
export const fieldDuplicate = (fieldId: string) => call<string>("field_duplicate", { fieldId });
export const fieldsReorder = (tableId: string, ids: string[]) => call<void>("fields_reorder", { tableId, ids });

// --- registros ---
export interface QueryResult {
  rows: RecordRow[];
  total: number;
}
export const recordsQuery = (
  tableId: string,
  opts: { filters?: FilterSpec[]; sorts?: SortSpec[]; search?: string; limit?: number; offset?: number } = {}
) =>
  call<QueryResult>("records_query", {
    tableId,
    filters: opts.filters ?? [],
    sorts: opts.sorts ?? [],
    search: opts.search ?? null,
    limit: opts.limit ?? null,
    offset: opts.offset ?? null,
  });
export const recordsByIds = (tableId: string, ids: number[]) => call<RecordRow[]>("records_by_ids", { tableId, ids });
export const recordCreate = (tableId: string, cells: Record<string, CellValue>) =>
  call<number>("record_create", { tableId, cells });
export const recordsUpdate = (tableId: string, updates: { id: number; cells: Record<string, CellValue> }[]) =>
  call<void>("records_update", { tableId, updates });
export const recordsDelete = (tableId: string, ids: number[]) => call<void>("records_delete", { tableId, ids });
export const recordsInsertBulk = (tableId: string, rows: Record<string, CellValue>[]) =>
  call<number[]>("records_insert_bulk", { tableId, rows });
export const recordsRestore = (tableId: string, rows: { id: number; cells: Record<string, CellValue> }[]) =>
  call<void>("records_restore", { tableId, rows });

// --- agregação (rodapé/relatório: feita no SQL) ---
export type AggQuery = { fieldId: string; kind: string }[];
export const recordsAggregate = (
  tableId: string,
  aggs: AggQuery,
  opts: { filters?: FilterSpec[]; search?: string } = {}
) =>
  call<Record<string, number | null>>("records_aggregate", {
    tableId,
    aggs,
    filters: opts.filters ?? [],
    search: opts.search ?? null,
  });

// --- views ---
export const viewCreate = (tableId: string, name: string, kind: ViewKind, config: ViewConfig) =>
  call<string>("view_create", { tableId, name, kind, config });
export const viewUpdate = (viewId: string, name?: string, config?: ViewConfig) =>
  call<void>("view_update", { viewId, name: name ?? null, config: config ?? null });
export const viewDuplicate = (viewId: string) => call<string>("view_duplicate", { viewId });
export const viewDelete = (viewId: string) => call<void>("view_delete", { viewId });

// --- anexos ---
export const attachmentImport = (paths: string[]) => invoke<AttachmentMeta[]>("attachment_import", { paths });
export const attachmentUpload = (name: string, base64Data: string) =>
  call<AttachmentMeta>("attachment_upload", { name, base64Data });
export const attachmentRead = (id: string) => call<string>("attachment_read", { id });
export const attachmentMetas = (ids: string[]) => call<AttachmentMeta[]>("attachment_metas", { ids });
export const attachmentsGc = () => call<number>("attachments_gc");

// --- auditoria ---
export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  tableId: string | null;
  recordId: number | null;
  detail: Record<string, unknown>;
}
export const auditQuery = (opts: { tableId?: string; recordId?: number; limit?: number; offset?: number } = {}) =>
  call<{ entries: AuditEntry[]; total: number }>("audit_query", {
    tableId: opts.tableId ?? null,
    recordId: opts.recordId ?? null,
    limit: opts.limit ?? null,
    offset: opts.offset ?? null,
  });

// --- usuários e permissões (admin) ---
export interface UserInfo {
  id: string;
  name: string;
  role: "leitor" | "editor" | "admin";
  perms: Record<string, "none" | "read" | "edit">;
}
export const usersList = () => call<UserInfo[]>("users_list");
export const userSave = (u: { id?: string; name: string; role: string; password?: string }) =>
  call<string>("user_save", { id: u.id ?? null, name: u.name, role: u.role, password: u.password ?? null });
export const userDelete = (userId: string) => call<void>("user_delete", { userId });
export const userSetPerm = (userId: string, tableId: string, level: string) =>
  call<void>("user_set_perm", { userId, tableId, level });

// --- automações ---
export interface AutomationMeta {
  id: string;
  tableId: string;
  config: Record<string, unknown>;
  pos: number;
}
export const automationsList = (tableId?: string) =>
  call<AutomationMeta[]>("automations_list", { tableId: tableId ?? null });
export const automationSave = (id: string | null, tableId: string, config: object) =>
  call<string>("automation_save", { id, tableId, config });
export const automationDelete = (id: string) => call<void>("automation_delete", { id });

// --- servidor (local; hospeda a base aberta pra rede) ---
export interface ServerStatus {
  running: boolean;
  port: number;
  lanIp: string;
}
export const serverStart = (port: number) => invoke<ServerStatus>("server_start", { port });
export const serverStop = () => invoke<void>("server_stop");
export const serverStatus = () => invoke<ServerStatus>("server_status");
