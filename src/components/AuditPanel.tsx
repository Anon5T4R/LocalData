// Histórico de alterações (auditoria): quem fez o quê e quando. Modal geral
// (toda a base) ou embutido por registro (ver AuditList).

import { useEffect, useState } from "react";
import * as api from "../lib/backend";
import { useStore } from "../state/store";
import { t as tr, localeTag, type MessageKey } from "../lib/i18n";

function tableName(store: ReturnType<typeof useStore.getState>, id: string | null): string {
  if (!id) return "—";
  return store.schema?.tables.find((t) => t.id === id)?.name ?? id;
}

const AUDIT_ACTIONS = new Set([
  "create", "update", "delete", "create_bulk", "update_bulk", "delete_bulk", "restore",
  "table_create", "table_rename", "table_delete", "table_duplicate",
  "field_create", "field_delete", "field_change_type",
  "user_create", "user_update", "user_delete",
  "automation_save", "automation_delete",
]);

function describe(e: api.AuditEntry): string {
  const base = AUDIT_ACTIONS.has(e.action) ? tr(`audit.${e.action}` as MessageKey) : e.action;
  const cnt = (e.detail as { count?: number }).count;
  return cnt ? tr("audit.withCount", { base, count: cnt }) : base;
}

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString(localeTag());
}

/** Lista embutida (usada no modal de registro e no painel geral). */
export function AuditList({ tableId, recordId }: { tableId?: string; recordId?: number }) {
  const store = useStore();
  const [entries, setEntries] = useState<api.AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    api
      .auditQuery({ tableId, recordId, limit: 100 })
      .then((r) => {
        if (dead) return;
        setEntries(r.entries);
        setTotal(r.total);
      })
      .catch(() => {})
      .finally(() => !dead && setLoading(false));
    return () => {
      dead = true;
    };
  }, [tableId, recordId]);

  if (loading) return <div className="muted audit-empty">{tr("audit.loading")}</div>;
  if (!entries.length) return <div className="muted audit-empty">{tr("audit.empty")}</div>;

  return (
    <div className="audit-list">
      {entries.map((e) => (
        <div key={e.id} className="audit-row">
          <span className="audit-actor">{e.actor}</span>
          <span className="audit-action">{describe(e)}</span>
          {!recordId && e.tableId && <span className="audit-where muted">{tr("audit.inTable", { name: tableName(store, e.tableId) })}</span>}
          {e.recordId != null && <span className="audit-where muted">#{e.recordId}</span>}
          <span className="audit-ts muted">{fmtTs(e.ts)}</span>
        </div>
      ))}
      {total > entries.length && <div className="muted audit-empty">{tr("audit.showing", { n: entries.length, total })}</div>}
    </div>
  );
}

export function AuditPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const [tableId, setTableId] = useState<string | "">("");
  const tables = store.schema?.tables ?? [];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal audit-panel">
        <div className="record-modal-head">
          <h3>{tr("audit.title")}</h3>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="pop-row">
          <label className="form-label">{tr("audit.table")}</label>
          <select className="input input-sm" value={tableId} onChange={(e) => setTableId(e.target.value)}>
            <option value="">{tr("audit.all")}</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <AuditList tableId={tableId || undefined} />
      </div>
    </div>
  );
}
