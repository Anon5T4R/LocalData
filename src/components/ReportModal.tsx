// Relatório imprimível da view atual → PDF pela impressora do SO (window.print
// com @media print). Zero dependências: é uma tabela HTML formatada com
// cabeçalho (base/tabela/data), filtros aplicados, agrupamento e totais.

import { useState } from "react";
import { activeTable, activeView, useStore, visibleFields } from "../state/store";
import { plainCellText } from "./cells";
import type { Field, RecordRow } from "../lib/types";

export function ReportModal({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const table = activeTable(store);
  const view = activeView(store);
  const [title, setTitle] = useState("");

  if (!table || !view) return null;

  const tables = store.schema?.tables ?? [];
  const fields = visibleFields(table, view);
  const rows = store.rows;
  const groupField = view.config.groupField ? table.fields.find((f) => f.id === view.config.groupField) : undefined;

  // agrupa (se configurado) mantendo a ordem atual das linhas
  const groups: { label: string; rows: RecordRow[] }[] = [];
  if (groupField) {
    const map = new Map<string, RecordRow[]>();
    for (const r of rows) {
      const label = plainCellText(groupField, r.cells[groupField.id] ?? null, tables) || "(vazio)";
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(r);
    }
    for (const [label, rs] of map) groups.push({ label, rows: rs });
  } else {
    groups.push({ label: "", rows });
  }

  const aggs = view.config.aggs ?? {};
  const aggFor = (f: Field, rs: RecordRow[]): string => {
    const kind = aggs[f.id];
    if (!kind) return "";
    if (kind === "filled") {
      const n = rs.filter((r) => {
        const v = r.cells[f.id];
        return v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
      }).length;
      return `${n}`;
    }
    const nums = rs.map((r) => r.cells[f.id]).filter((v): v is number => typeof v === "number");
    if (!nums.length) return "";
    let out = 0;
    if (kind === "sum") out = nums.reduce((a, b) => a + b, 0);
    else if (kind === "avg") out = nums.reduce((a, b) => a + b, 0) / nums.length;
    else if (kind === "min") out = Math.min(...nums);
    else out = Math.max(...nums);
    return String(Math.round(out * 100) / 100);
  };
  const hasAggRow = fields.some((f) => aggs[f.id]);

  const filterText =
    (view.config.filters ?? []).length > 0
      ? `${(view.config.filters ?? []).length} filtro(s) aplicado(s)`
      : "sem filtros";

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal report-modal">
        <div className="record-modal-head no-print">
          <h3>Relatório — {table.name}</h3>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="pop-row no-print">
          <input
            className="input input-sm"
            placeholder="Título do relatório (opcional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="btn btn-sm primary" onClick={() => window.print()}>
            🖨 Imprimir / salvar PDF
          </button>
        </div>
        <p className="muted no-print">
          A janela de impressão do sistema permite "Salvar como PDF". {rows.length} de {store.total} registros
          {rows.length < store.total ? " (carregando o restante…)" : ""}.
        </p>

        <div className="report-sheet" id="report-sheet">
          <div className="report-head">
            <h1>{title || table.name}</h1>
            <div className="report-meta">
              <span>{store.schema?.name}</span>
              <span>{new Date().toLocaleString("pt-BR")}</span>
              <span>{filterText}</span>
              <span>{store.total} registros</span>
            </div>
          </div>
          <table className="report-table">
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f.id}>{f.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g, gi) => (
                <ReportGroup key={gi} label={g.label} rows={g.rows} fields={fields} tables={tables} showGroup={!!groupField} />
              ))}
            </tbody>
            {hasAggRow && (
              <tfoot>
                <tr>
                  {fields.map((f, i) => (
                    <td key={f.id}>{i === 0 && !aggs[f.id] ? "Total geral" : aggFor(f, rows)}</td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

function ReportGroup({
  label,
  rows,
  fields,
  tables,
  showGroup,
}: {
  label: string;
  rows: RecordRow[];
  fields: Field[];
  tables: { id: string; name: string; fields: Field[] }[];
  showGroup: boolean;
}) {
  return (
    <>
      {showGroup && (
        <tr className="report-group">
          <td colSpan={fields.length}>
            {label} <span className="report-group-count">({rows.length})</span>
          </td>
        </tr>
      )}
      {rows.map((r) => (
        <tr key={r.id}>
          {fields.map((f) => (
            <td key={f.id}>{plainCellText(f, r.cells[f.id] ?? null, tables as never)}</td>
          ))}
        </tr>
      ))}
    </>
  );
}
