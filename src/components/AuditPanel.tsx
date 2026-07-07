// Histórico de alterações (auditoria): quem fez o quê e quando. Modal geral
// (toda a base) ou embutido por registro (ver AuditList).

import { useEffect, useState } from "react";
import * as api from "../lib/backend";
import { useStore } from "../state/store";

function tableName(store: ReturnType<typeof useStore.getState>, id: string | null): string {
  if (!id) return "—";
  return store.schema?.tables.find((t) => t.id === id)?.name ?? id;
}

function describe(e: api.AuditEntry): string {
  const map: Record<string, string> = {
    create: "criou registro",
    update: "editou registro",
    delete: "excluiu registro",
    create_bulk: "criou vários registros",
    update_bulk: "editou vários registros",
    delete_bulk: "excluiu vários registros",
    restore: "restaurou registros",
    table_create: "criou tabela",
    table_rename: "renomeou tabela",
    table_delete: "excluiu tabela",
    table_duplicate: "duplicou tabela",
    field_create: "criou campo",
    field_delete: "excluiu campo",
    field_change_type: "mudou tipo de campo",
    user_create: "criou usuário",
    user_update: "editou usuário",
    user_delete: "excluiu usuário",
    automation_save: "salvou automação",
    automation_delete: "excluiu automação",
  };
  const base = map[e.action] ?? e.action;
  const cnt = (e.detail as { count?: number }).count;
  return cnt ? `${base} (${cnt})` : base;
}

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString("pt-BR");
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

  if (loading) return <div className="muted audit-empty">carregando histórico…</div>;
  if (!entries.length) return <div className="muted audit-empty">Sem registros de alteração ainda.</div>;

  return (
    <div className="audit-list">
      {entries.map((e) => (
        <div key={e.id} className="audit-row">
          <span className="audit-actor">{e.actor}</span>
          <span className="audit-action">{describe(e)}</span>
          {!recordId && e.tableId && <span className="audit-where muted">em {tableName(store, e.tableId)}</span>}
          {e.recordId != null && <span className="audit-where muted">#{e.recordId}</span>}
          <span className="audit-ts muted">{fmtTs(e.ts)}</span>
        </div>
      ))}
      {total > entries.length && <div className="muted audit-empty">mostrando as {entries.length} mais recentes de {total}</div>}
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
          <h3>🕘 Histórico de alterações</h3>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="pop-row">
          <label className="form-label">Tabela</label>
          <select className="input input-sm" value={tableId} onChange={(e) => setTableId(e.target.value)}>
            <option value="">(todas)</option>
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
