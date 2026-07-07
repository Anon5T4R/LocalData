// Render e edição de célula por tipo de campo — usado pela grade, pelo modal
// de registro, pelo formulário e pelos cartões (kanban/galeria).

import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../lib/backend";

/** Abre um link no app padrão do sistema (fallback: nova aba no browser). */
async function openLink(href: string) {
  try {
    if (api.inTauri()) await openUrl(href);
    else window.open(href, "_blank", "noopener");
  } catch {
    /* opener pode não estar liberado — ignora */
  }
}
import { compileFormula, formatFormulaValue } from "../lib/formula";
import type { AttachmentMeta, CellValue, Choice, Field, RecordRow, Table } from "../lib/types";
import { choiceColor } from "../lib/types";
import { extTypeSpec } from "../lib/extensions";
import { useStore } from "../state/store";

// ---------------------------------------------------------------------------
// caches de exibição (rótulos de relação e metadados/miniaturas de anexo)
// ---------------------------------------------------------------------------

// Linhas completas dos registros relacionados (null = registro removido).
// Alimenta tanto os rótulos dos chips de relação quanto lookup/rollup.
const linkRowCache = new Map<string, Map<number, RecordRow | null>>();

/** Linhas dos registros relacionados, buscadas sob demanda e cacheadas. */
export function useLinkedRows(targetTable: Table | undefined, ids: number[]): Map<number, RecordRow | null> {
  const [, bump] = useState(0);
  const key = targetTable?.id ?? "";
  useEffect(() => {
    if (!targetTable || !ids.length) return;
    let cache = linkRowCache.get(key);
    if (!cache) {
      cache = new Map();
      linkRowCache.set(key, cache);
    }
    const missing = ids.filter((id) => !cache!.has(id));
    if (!missing.length) return;
    let dead = false;
    api
      .recordsByIds(targetTable.id, missing)
      .then((rows) => {
        if (dead) return;
        for (const r of rows) cache!.set(r.id, r);
        for (const id of missing) if (!cache!.has(id)) cache!.set(id, null);
        bump((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [key, ids.join(","), targetTable]); // eslint-disable-line react-hooks/exhaustive-deps
  return linkRowCache.get(key) ?? new Map();
}

/** Rótulos (campo primário) dos registros relacionados. */
export function useLinkLabels(targetTable: Table | undefined, ids: number[]): Map<number, string> {
  const rows = useLinkedRows(targetTable, ids);
  const out = new Map<number, string>();
  const primary = targetTable?.fields[0];
  for (const [id, r] of rows) {
    if (!r) {
      out.set(id, `#${id}? (removido)`);
      continue;
    }
    const v = primary ? r.cells[primary.id] : null;
    out.set(id, v == null || v === "" ? `#${id}` : String(v));
  }
  return out;
}

/** Invalida o cache de linhas relacionadas (após editar registros da tabela alvo). */
export function invalidateLinkLabels(tableId?: string) {
  if (tableId) linkRowCache.delete(tableId);
  else linkRowCache.clear();
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

export function formatNumber(v: number, opts?: { precision?: number; format?: string }): string {
  const precision = opts?.precision;
  switch (opts?.format) {
    case "integer":
      return Math.round(v).toLocaleString("pt-BR");
    case "currency":
      return v.toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
        minimumFractionDigits: precision ?? 2,
        maximumFractionDigits: precision ?? 2,
      });
    case "percent": {
      const s = precision != null ? v.toFixed(precision).replace(".", ",") : String(Math.round(v * 1e6) / 1e6).replace(".", ",");
      return s + "%";
    }
    default:
      if (precision != null) return v.toFixed(precision).replace(".", ",");
      return String(Math.round(v * 1e6) / 1e6).replace(".", ",");
  }
}

/**
 * Valor de célula como texto simples, por tipo (select vira nome da opção,
 * data vira dd/mm/aaaa etc.) — usado por lookup/rollup, copiar/colar e export.
 */
export function plainCellText(field: Field, value: CellValue, tables: Table[]): string {
  if (value == null || value === "") return "";
  switch (field.type) {
    case "number":
      return typeof value === "number" ? formatNumber(value, field.options) : String(value);
    case "rating":
      return typeof value === "number" ? String(value) : "";
    case "checkbox":
      return value ? "✓" : "";
    case "date":
      return typeof value === "string" ? formatDate(value, field.options.includeTime) : "";
    case "select": {
      const c = (field.options.choices ?? []).find((c) => c.id === value);
      return c?.name ?? "";
    }
    case "multi_select": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const choices = field.options.choices ?? [];
      return ids.map((id) => choices.find((c) => c.id === id)?.name ?? "").filter(Boolean).join(", ");
    }
    case "link": {
      // rótulos podem não estar no cache ainda; usa o que houver
      const target = tables.find((t) => t.id === field.options.tableId);
      const cache = target ? linkRowCache.get(target.id) : undefined;
      const primary = target?.fields[0];
      const ids = Array.isArray(value) ? (value as number[]) : [];
      return ids
        .map((id) => {
          const r = cache?.get(id);
          const v = r && primary ? r.cells[primary.id] : null;
          return v == null || v === "" ? `#${id}` : String(v);
        })
        .join(", ");
    }
    case "attachment": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      return ids.map((id) => attMetaCache.get(id)?.name ?? "📎").join(", ");
    }
    case "custom": {
      const ext = extTypeSpec(field.options.extType);
      if (ext?.format) {
        try {
          return ext.format(String(value));
        } catch {
          /* extensão quebrada não derruba a célula */
        }
      }
      return String(value);
    }
    default:
      return String(value);
  }
}

function ChoiceChip({ choice, idx }: { choice: Choice; idx: number }) {
  return (
    <span className="chip" style={{ background: choiceColor(choice, idx) }}>
      {choice.name}
    </span>
  );
}

/** Estrelas de avaliação; com onRate vira clicável (clicar na atual limpa). */
export function RatingStars({
  value,
  max,
  onRate,
}: {
  value: number;
  max: number;
  onRate?: (n: number) => void;
}) {
  return (
    <span className={"stars" + (onRate ? " editable" : "")}>
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className={"star" + (i < value ? " on" : "")}
          onClick={
            onRate
              ? (e) => {
                  e.stopPropagation();
                  onRate(i + 1 === value ? 0 : i + 1);
                }
              : undefined
          }
        >
          ★
        </span>
      ))}
    </span>
  );
}

/** Agrega valores de um rollup. */
export function computeRollup(
  agg: string,
  targetField: Field,
  values: CellValue[],
  tables: Table[]
): string {
  const present = values.filter((v) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0));
  switch (agg) {
    case "count":
      return String(present.length);
    case "join":
      return present.map((v) => plainCellText(targetField, v, tables)).filter(Boolean).join(", ");
    default: {
      const nums = present
        .map((v) => (typeof v === "number" ? v : parseFloat(String(v).replace(",", "."))))
        .filter((n) => !isNaN(n));
      if (!nums.length) return "";
      let out: number;
      switch (agg) {
        case "sum":
          out = nums.reduce((a, b) => a + b, 0);
          break;
        case "avg":
          out = nums.reduce((a, b) => a + b, 0) / nums.length;
          break;
        case "min":
          out = Math.min(...nums);
          break;
        default:
          out = Math.max(...nums);
      }
      return formatNumber(Math.round(out * 1e6) / 1e6, targetField.options);
    }
  }
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
  onRate,
}: {
  field: Field;
  value: CellValue;
  row: RecordRow;
  table: Table;
  tables: Table[];
  /** checkbox alterna direto no clique (grade) */
  onToggle?: (v: boolean) => void;
  /** rating define direto no clique (grade) */
  onRate?: (n: number) => void;
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

  // lookup/rollup: registros da tabela alvo via o campo de relação configurado
  const isViaLink = field.type === "lookup" || field.type === "rollup";
  const viaField = isViaLink
    ? table.fields.find((f) => f.id === field.options.linkFieldId && f.type === "link")
    : undefined;
  const viaRaw = viaField ? row.cells[viaField.id] : null;
  const viaIds = viaField && Array.isArray(viaRaw) ? (viaRaw as number[]) : [];
  const viaTable = viaField ? tables.find((t) => t.id === viaField.options.tableId) : undefined;
  const viaRows = useLinkedRows(viaTable, viaIds);

  switch (field.type) {
    case "lookup":
    case "rollup": {
      const targetField = viaTable?.fields.find((f) => f.id === field.options.targetFieldId);
      if (!viaField || !viaTable || !targetField) {
        return <span className="cell-config-warn">⚠ configurar campo</span>;
      }
      const values = viaIds.map((id) => viaRows.get(id)?.cells[targetField.id] ?? null);
      if (field.type === "rollup") {
        return <span className="cell-num">{computeRollup(field.options.agg ?? "count", targetField, values, tables)}</span>;
      }
      const texts = values.map((v) => plainCellText(targetField, v, tables)).filter(Boolean);
      return <span className="cell-lookup">{texts.join(", ")}</span>;
    }
    case "rating": {
      const max = field.options.max ?? 5;
      const n = typeof value === "number" ? value : 0;
      return <RatingStars value={n} max={max} onRate={onRate} />;
    }
    case "custom": {
      if (value == null || value === "") return <span />;
      const ext = extTypeSpec(field.options.extType);
      let text = String(value);
      let color: string | undefined;
      try {
        if (ext?.format) text = ext.format(String(value));
        if (ext?.color) color = ext.color(String(value));
      } catch {
        /* extensão quebrada não derruba a célula: mostra o valor cru */
      }
      return (
        <span style={color ? { color } : undefined} title={ext ? undefined : `extensão "${field.options.extType}" não carregada`}>
          {text}
        </span>
      );
    }
    case "url":
    case "email":
    case "phone": {
      const s = typeof value === "string" ? value : "";
      if (!s) return <span />;
      const href = field.type === "url" ? (s.match(/^[a-z]+:\/\//i) ? s : `https://${s}`) : field.type === "email" ? `mailto:${s}` : `tel:${s}`;
      return (
        <a
          className="cell-link"
          href={href}
          title={href}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void openLink(href);
          }}
        >
          {s}
        </a>
      );
    }
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
      return <span className="cell-num">{typeof value === "number" ? formatNumber(value, field.options) : ""}</span>;
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
    case "url":
    case "email":
    case "phone":
      return <TextEditor value={value} commit={commit} cancel={cancel} autoFocus={autoFocus} />;
    case "long_text":
      return <TextEditor value={value} commit={commit} cancel={cancel} autoFocus={autoFocus} multiline />;
    case "custom": {
      const ext = extTypeSpec(field.options.extType);
      return (
        <TextEditor
          value={value}
          commit={(v) => {
            const raw = v == null ? "" : String(v);
            if (raw === "" || !ext?.parse) {
              commit(raw === "" ? null : raw);
              return;
            }
            try {
              commit(ext.parse(raw));
            } catch (e) {
              useStore.getState().setError(`${field.name}: ${e instanceof Error ? e.message : e}`);
              cancel();
            }
          }}
          cancel={cancel}
          autoFocus={autoFocus}
          multiline={ext?.multiline}
          placeholder={ext?.placeholder}
        />
      );
    }
    case "number":
      return <TextEditor value={value} commit={(v) => commit(parseNum(v))} cancel={cancel} autoFocus={autoFocus} numeric />;
    case "rating": {
      const max = field.options.max ?? 5;
      const n = typeof value === "number" ? value : 0;
      return (
        <span className="cell-rating-edit">
          <RatingStars value={n} max={max} onRate={(v) => commit(v || null)} />
        </span>
      );
    }
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
  placeholder,
}: {
  value: CellValue;
  commit: (v: CellValue) => void;
  cancel: () => void;
  autoFocus: boolean;
  multiline?: boolean;
  numeric?: boolean;
  placeholder?: string;
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
        placeholder={placeholder}
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
      placeholder={placeholder}
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
