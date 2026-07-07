// Render e edição de célula por tipo de campo — usado pela grade, pelo modal
// de registro, pelo formulário e pelos cartões (kanban/galeria).

import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../lib/backend";
import { compileFormula, formatFormulaValue } from "../lib/formula";
import type { AttachmentMeta, CellValue, Choice, Field, RecordRow, Table } from "../lib/types";
import { choiceColor } from "../lib/types";

// ---------------------------------------------------------------------------
// caches de exibição (rótulos de relação e metadados/miniaturas de anexo)
// ---------------------------------------------------------------------------

const linkLabelCache = new Map<string, Map<number, string>>();

/** Rótulos (campo primário) dos registros relacionados. */
export function useLinkLabels(targetTable: Table | undefined, ids: number[]): Map<number, string> {
  const [, bump] = useState(0);
  const key = targetTable?.id ?? "";
  useEffect(() => {
    if (!targetTable || !ids.length) return;
    let cache = linkLabelCache.get(key);
    if (!cache) {
      cache = new Map();
      linkLabelCache.set(key, cache);
    }
    const missing = ids.filter((id) => !cache!.has(id));
    if (!missing.length) return;
    let dead = false;
    api
      .recordsByIds(targetTable.id, missing)
      .then((rows) => {
        if (dead) return;
        const primary = targetTable.fields[0];
        for (const r of rows) {
          const v = primary ? r.cells[primary.id] : null;
          cache!.set(r.id, v == null || v === "" ? `#${r.id}` : String(v));
        }
        for (const id of missing) if (!cache!.has(id)) cache!.set(id, `#${id}? (removido)`);
        bump((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [key, ids.join(","), targetTable]); // eslint-disable-line react-hooks/exhaustive-deps
  return linkLabelCache.get(key) ?? new Map();
}

/** Invalida o cache de rótulos (após editar registros da tabela alvo). */
export function invalidateLinkLabels(tableId?: string) {
  if (tableId) linkLabelCache.delete(tableId);
  else linkLabelCache.clear();
}

const attMetaCache = new Map<string, AttachmentMeta>();
const attThumbCache = new Map<string, string>(); // id -> data URL

export function useAttachments(ids: string[]): { metas: AttachmentMeta[]; thumbs: Map<string, string> } {
  const [, bump] = useState(0);
  useEffect(() => {
    const missing = ids.filter((id) => !attMetaCache.has(id));
    if (!missing.length) return;
    let dead = false;
    api
      .attachmentMetas(missing)
      .then(async (metas) => {
        for (const m of metas) attMetaCache.set(m.id, m);
        // miniaturas só de imagem, uma por vez
        for (const m of metas) {
          if (m.mime.startsWith("image/") && !attThumbCache.has(m.id) && m.size < 8_000_000) {
            try {
              const b64 = await api.attachmentRead(m.id);
              attThumbCache.set(m.id, `data:${m.mime};base64,${b64}`);
            } catch {
              /* sem thumb */
            }
          }
        }
        if (!dead) bump((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [ids.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const metas = ids.map((id) => attMetaCache.get(id)).filter((m): m is AttachmentMeta => !!m);
  return { metas, thumbs: attThumbCache };
}

export function attachmentThumb(id: string): string | undefined {
  return attThumbCache.get(id);
}

// ---------------------------------------------------------------------------
// formatação de exibição
// ---------------------------------------------------------------------------

export function formatDate(v: string, includeTime?: boolean): string {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return v;
  const base = `${m[3]}/${m[2]}/${m[1]}`;
  return includeTime && m[4] ? `${base} ${m[4]}:${m[5]}` : base;
}

export function formatNumber(v: number, precision?: number): string {
  if (precision != null) return v.toFixed(precision).replace(".", ",");
  return String(Math.round(v * 1e6) / 1e6).replace(".", ",");
}

function ChoiceChip({ choice, idx }: { choice: Choice; idx: number }) {
  return (
    <span className="chip" style={{ background: choiceColor(choice, idx) }}>
      {choice.name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// CellDisplay
// ---------------------------------------------------------------------------

export function CellDisplay({
  field,
  value,
  row,
  table,
  tables,
  onToggle,
}: {
  field: Field;
  value: CellValue;
  row: RecordRow;
  table: Table;
  tables: Table[];
  /** checkbox alterna direto no clique (grade) */
  onToggle?: (v: boolean) => void;
}) {
  const formula = useMemo(
    () => (field.type === "formula" ? compileFormula(field.options.expr ?? "", table.fields) : null),
    [field, table.fields]
  );

  const linkIds = field.type === "link" && Array.isArray(value) ? (value as number[]) : [];
  const targetTable = field.type === "link" ? tables.find((t) => t.id === field.options.tableId) : undefined;
  const labels = useLinkLabels(targetTable, linkIds);

  const attIds = field.type === "attachment" && Array.isArray(value) ? (value as string[]) : [];
  const { metas, thumbs } = useAttachments(attIds);

  switch (field.type) {
    case "checkbox":
      return (
        <span
          className={"cell-check" + (value ? " on" : "")}
          onClick={
            onToggle
              ? (e) => {
                  e.stopPropagation();
                  onToggle(!value);
                }
              : undefined
          }
        >
          {value ? "✓" : ""}
        </span>
      );
    case "number":
      return <span className="cell-num">{typeof value === "number" ? formatNumber(value, field.options.precision) : ""}</span>;
    case "date":
      return <span>{typeof value === "string" && value ? formatDate(value, field.options.includeTime) : ""}</span>;
    case "select": {
      const idx = (field.options.choices ?? []).findIndex((c) => c.id === value);
      const choice = idx >= 0 ? field.options.choices![idx] : null;
      return choice ? <ChoiceChip choice={choice} idx={idx} /> : <span />;
    }
    case "multi_select": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const choices = field.options.choices ?? [];
      return (
        <span className="chips">
          {ids.map((id) => {
            const idx = choices.findIndex((c) => c.id === id);
            return idx >= 0 ? <ChoiceChip key={id} choice={choices[idx]} idx={idx} /> : null;
          })}
        </span>
      );
    }
    case "link":
      return (
        <span className="chips">
          {linkIds.map((id) => (
            <span key={id} className="chip chip-link">
              {labels.get(id) ?? "…"}
            </span>
          ))}
        </span>
      );
    case "attachment":
      return (
        <span className="chips">
          {metas.map((m) =>
            thumbs.get(m.id) ? (
              <img key={m.id} className="att-thumb" src={thumbs.get(m.id)} alt={m.name} title={m.name} />
            ) : (
              <span key={m.id} className="chip chip-att" title={m.name}>
                📎 {m.name.length > 18 ? m.name.slice(0, 16) + "…" : m.name}
              </span>
            )
          )}
        </span>
      );
    case "formula": {
      const v = formula ? formula.eval(row, table.fields) : null;
      return <span className={"cell-formula" + (v === "#ERRO" ? " err" : "")}>{formatFormulaValue(v)}</span>;
    }
    case "long_text":
      return <span className="cell-longtext">{typeof value === "string" ? value : ""}</span>;
    default:
      return <span>{value == null ? "" : String(value)}</span>;
  }
}

// ---------------------------------------------------------------------------
// CellEditor — edição inline; chama commit(valor) ou cancel()
// ---------------------------------------------------------------------------

export function CellEditor({
  field,
  value,
  tables,
  commit,
  cancel,
  autoFocus = true,
}: {
  field: Field;
  value: CellValue;
  tables: Table[];
  commit: (v: CellValue) => void;
  cancel: () => void;
  autoFocus?: boolean;
}) {
  switch (field.type) {
    case "text":
      return <TextEditor value={value} commit={commit} cancel={cancel} autoFocus={autoFocus} />;
    case "long_text":
      return <TextEditor value={value} commit={commit} cancel={cancel} autoFocus={autoFocus} multiline />;
    case "number":
      return <TextEditor value={value} commit={(v) => commit(parseNum(v))} cancel={cancel} autoFocus={autoFocus} numeric />;
    case "date":
      return <DateEditor value={value} includeTime={field.options.includeTime} commit={commit} cancel={cancel} />;
    case "select":
      return <SelectEditor field={field} value={value} commit={commit} cancel={cancel} multi={false} />;
    case "multi_select":
      return <SelectEditor field={field} value={value} commit={commit} cancel={cancel} multi />;
    case "link":
      return <LinkEditor field={field} value={value} tables={tables} commit={commit} cancel={cancel} />;
    case "attachment":
      return <AttachmentEditor value={value} commit={commit} cancel={cancel} />;
    default:
      // checkbox alterna no display; formula é somente leitura
      cancel();
      return null;
  }
}

function parseNum(v: CellValue): CellValue {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(",", "."));
  return isNaN(n) ? null : n;
}

function TextEditor({
  value,
  commit,
  cancel,
  autoFocus,
  multiline,
  numeric,
}: {
  value: CellValue;
  commit: (v: CellValue) => void;
  cancel: () => void;
  autoFocus: boolean;
  multiline?: boolean;
  numeric?: boolean;
}) {
  const [v, setV] = useState(value == null ? "" : String(value).replace(".", numeric ? "," : "."));
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      if (ref.current instanceof HTMLInputElement) ref.current.select();
    }
  }, [autoFocus]);
  const done = () => commit(v === "" ? null : v);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !(multiline && e.shiftKey)) {
      e.preventDefault();
      done();
    }
    if (e.key === "Escape") cancel();
  };
  if (multiline) {
    return (
      <textarea
        ref={ref as React.RefObject<HTMLTextAreaElement>}
        className="cell-input cell-textarea"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={done}
        onKeyDown={onKey}
        rows={4}
      />
    );
  }
  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      className="cell-input"
      value={v}
      inputMode={numeric ? "decimal" : undefined}
      onChange={(e) => setV(e.target.value)}
      onBlur={done}
      onKeyDown={onKey}
    />
  );
}

function DateEditor({
  value,
  includeTime,
  commit,
  cancel,
}: {
  value: CellValue;
  includeTime?: boolean;
  commit: (v: CellValue) => void;
  cancel: () => void;
}) {
  const [v, setV] = useState(typeof value === "string" ? value : "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <input
      ref={ref}
      type={includeTime ? "datetime-local" : "date"}
      className="cell-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => commit(v || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(v || null);
        if (e.key === "Escape") cancel();
      }}
    />
  );
}

function SelectEditor({
  field,
  value,
  commit,
  cancel,
  multi,
}: {
  field: Field;
  value: CellValue;
  commit: (v: CellValue) => void;
  cancel: () => void;
  multi: boolean;
}) {
  const choices = field.options.choices ?? [];
  const selected = new Set(multi ? (Array.isArray(value) ? (value as string[]) : []) : value ? [String(value)] : []);
  const [sel, setSel] = useState(selected);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, () => (multi ? commit(Array.from(sel)) : cancel()));
  return (
    <div ref={ref} className="cell-pop">
      {choices.map((c, i) => (
        <div
          key={c.id}
          className={"cell-pop-item" + (sel.has(c.id) ? " sel" : "")}
          onClick={() => {
            if (multi) {
              const next = new Set(sel);
              if (next.has(c.id)) next.delete(c.id);
              else next.add(c.id);
              setSel(next);
            } else {
              commit(c.id);
            }
          }}
        >
          <ChoiceChip choice={c} idx={i} />
          {sel.has(c.id) && <span className="tick">✓</span>}
        </div>
      ))}
      {!multi && (
        <div className="cell-pop-item" onClick={() => commit(null)}>
          <span className="muted">(limpar)</span>
        </div>
      )}
      {multi && (
        <div className="cell-pop-actions">
          <button className="btn btn-sm" onClick={() => commit(Array.from(sel))}>
            OK
          </button>
        </div>
      )}
      {!choices.length && <div className="cell-pop-item muted">Sem opções — edite o campo</div>}
    </div>
  );
}

function LinkEditor({
  field,
  value,
  tables,
  commit,
  cancel,
}: {
  field: Field;
  value: CellValue;
  tables: Table[];
  commit: (v: CellValue) => void;
  cancel: () => void;
}) {
  const target = tables.find((t) => t.id === field.options.tableId);
  const [sel, setSel] = useState<number[]>(Array.isArray(value) ? (value as number[]) : []);
  const [q, setQ] = useState("");
  const [cands, setCands] = useState<RecordRow[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, () => commit(sel));
  useEffect(() => {
    if (!target) return;
    let dead = false;
    api
      .recordsQuery(target.id, { search: q || undefined, limit: 20 })
      .then((r) => {
        if (!dead) setCands(r.rows);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [q, target?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!target) {
    return (
      <div ref={ref} className="cell-pop">
        <div className="cell-pop-item muted">Tabela alvo não existe mais</div>
      </div>
    );
  }
  const primary = target.fields[0];
  const label = (r: RecordRow) => {
    const v = primary ? r.cells[primary.id] : null;
    return v == null || v === "" ? `#${r.id}` : String(v);
  };
  return (
    <div ref={ref} className="cell-pop cell-pop-wide">
      <input
        className="cell-input"
        placeholder={`Buscar em ${target.name}…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && cancel()}
        autoFocus
      />
      {cands.map((r) => {
        const on = sel.includes(r.id);
        return (
          <div
            key={r.id}
            className={"cell-pop-item" + (on ? " sel" : "")}
            onClick={() => setSel(on ? sel.filter((i) => i !== r.id) : [...sel, r.id])}
          >
            <span className="chip chip-link">{label(r)}</span>
            {on && <span className="tick">✓</span>}
          </div>
        );
      })}
      {!cands.length && <div className="cell-pop-item muted">Nenhum registro</div>}
      <div className="cell-pop-actions">
        <button className="btn btn-sm" onClick={() => commit(sel)}>
          OK
        </button>
      </div>
    </div>
  );
}

function AttachmentEditor({
  value,
  commit,
  cancel,
}: {
  value: CellValue;
  commit: (v: CellValue) => void;
  cancel: () => void;
}) {
  const [ids, setIds] = useState<string[]>(Array.isArray(value) ? (value as string[]) : []);
  const { metas } = useAttachments(ids);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, () => commit(ids));
  const addFiles = async () => {
    try {
      const picked = await openDialog({ multiple: true, title: "Anexar arquivos" });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      const added = await api.attachmentImport(paths as string[]);
      setIds((cur) => [...cur, ...added.map((a) => a.id)]);
    } catch {
      /* cancelado */
    }
  };
  return (
    <div ref={ref} className="cell-pop cell-pop-wide">
      {metas.map((m) => (
        <div key={m.id} className="cell-pop-item">
          <span className="chip chip-att" title={m.name}>
            📎 {m.name}
          </span>
          <button className="icon-btn" title="Remover" onClick={() => setIds(ids.filter((i) => i !== m.id))}>
            ×
          </button>
        </div>
      ))}
      <div className="cell-pop-actions">
        <button className="btn btn-sm" onClick={addFiles}>
          + Anexar arquivo
        </button>
        <button className="btn btn-sm primary" onClick={() => commit(ids)}>
          OK
        </button>
        <button className="btn btn-sm" onClick={cancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function useOutsideClick(ref: React.RefObject<HTMLElement | null>, onOutside: () => void) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    // timeout evita fechar no mesmo clique que abriu
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handler);
    };
  }, [ref, onOutside]);
}
