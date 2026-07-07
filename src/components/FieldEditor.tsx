// Criar/editar campo: nome, tipo e opções específicas do tipo.
// Mudança de tipo converte os valores existentes no backend (melhor esforço).

import { useState } from "react";
import { activeTable, useStore } from "../state/store";
import type { Choice, Field, FieldOptions, FieldType, NumberFormat, RollupAgg } from "../lib/types";
import { CHOICE_COLORS, FIELD_TYPE_LABEL, ROLLUP_AGG_LABEL, isComputed } from "../lib/types";
import { useExtensions } from "../lib/extensions";

let choiceSeq = 0;
function newChoiceId(): string {
  return `ch${Date.now().toString(36)}${(choiceSeq++).toString(36)}`;
}

export function FieldEditor({
  mode,
  field,
  onClose,
}: {
  mode: "new" | "edit";
  field?: Field;
  onClose: () => void;
}) {
  const store = useStore();
  const table = activeTable(store);
  const tables = store.schema?.tables ?? [];

  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<FieldType>(field?.type ?? "text");
  const [choices, setChoices] = useState<Choice[]>(field?.options.choices ?? []);
  const [targetTable, setTargetTable] = useState(field?.options.tableId ?? tables[0]?.id ?? "");
  const [expr, setExpr] = useState(field?.options.expr ?? "");
  const [precision, setPrecision] = useState(field?.options.precision?.toString() ?? "");
  const [format, setFormat] = useState<NumberFormat>(field?.options.format ?? "decimal");
  const [includeTime, setIncludeTime] = useState(field?.options.includeTime ?? false);
  const [ratingMax, setRatingMax] = useState(field?.options.max?.toString() ?? "5");
  const [linkFieldId, setLinkFieldId] = useState(field?.options.linkFieldId ?? "");
  const [targetFieldId, setTargetFieldId] = useState(field?.options.targetFieldId ?? "");
  const [agg, setAgg] = useState<RollupAgg>(field?.options.agg ?? "count");
  const [extTypeId, setExtTypeId] = useState(field?.options.extType ?? "");
  const [description, setDescription] = useState(field?.options.description ?? "");
  const [busy, setBusy] = useState(false);
  const extTypes = useExtensions((s) => s.types);

  if (!table) return null;

  const selectedExt = extTypes.find((e) => e.id === extTypeId);
  // campo custom cuja extensão sumiu ainda precisa aparecer no seletor
  const orphanExt = type === "custom" && extTypeId && !selectedExt ? extTypeId : null;

  // lookup/rollup: relações desta tabela e campos (com coluna) da tabela alvo
  const linkFields = table.fields.filter((f) => f.type === "link" && f.id !== field?.id);
  const viaField = linkFields.find((f) => f.id === linkFieldId) ?? linkFields[0];
  const viaTable = viaField ? tables.find((t) => t.id === viaField.options.tableId) : undefined;
  const targetFields = (viaTable?.fields ?? []).filter((f) => !isComputed(f.type));

  const buildOptions = (): FieldOptions => {
    const o: FieldOptions = {};
    if (type === "select" || type === "multi_select") o.choices = choices;
    if (type === "link") o.tableId = targetTable;
    if (type === "formula") o.expr = expr;
    if (type === "number") {
      if (precision !== "") o.precision = Math.max(0, Math.min(8, parseInt(precision, 10) || 0));
      if (format !== "decimal") o.format = format;
    }
    if (type === "date") o.includeTime = includeTime;
    if (type === "rating") o.max = Math.max(1, Math.min(10, parseInt(ratingMax, 10) || 5));
    if (type === "lookup" || type === "rollup") {
      o.linkFieldId = viaField?.id ?? "";
      o.targetFieldId = targetFields.some((f) => f.id === targetFieldId) ? targetFieldId : targetFields[0]?.id ?? "";
      if (type === "rollup") o.agg = agg;
    }
    if (type === "custom") o.extType = extTypeId;
    if (description.trim()) o.description = description.trim();
    return o;
  };

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (mode === "new") {
        await store.addField(name.trim(), type, buildOptions());
      } else if (field) {
        if (field.type !== type) {
          await store.changeFieldType(field.id, type, buildOptions());
          await store.updateField(field.id, name.trim());
        } else {
          await store.updateField(field.id, name.trim(), buildOptions());
        }
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal field-editor">
        <h3>{mode === "new" ? "Novo campo" : "Editar campo"}</h3>

        <label className="form-label">Nome</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Nome do campo" />

        <label className="form-label">Tipo</label>
        <select
          className="input"
          value={type === "custom" ? `custom:${extTypeId}` : type}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("custom:")) {
              setType("custom");
              setExtTypeId(v.slice(7));
            } else {
              setType(v as FieldType);
            }
          }}
        >
          {(Object.keys(FIELD_TYPE_LABEL) as FieldType[])
            .filter((t) => t !== "custom")
            .map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABEL[t]}
              </option>
            ))}
          {(extTypes.length > 0 || orphanExt) && (
            <optgroup label="Extensões (🧩)">
              {extTypes.map((e) => (
                <option key={e.id} value={`custom:${e.id}`}>
                  {e.icon ? `${e.icon} ` : ""}{e.name}
                </option>
              ))}
              {orphanExt && (
                <option value={`custom:${orphanExt}`}>⚠ {orphanExt} (extensão não carregada)</option>
              )}
            </optgroup>
          )}
        </select>
        {type === "custom" && selectedExt?.description && <p className="hint">{selectedExt.description}</p>}
        {type === "custom" && !selectedExt && (
          <p className="hint warn">
            A extensão "{extTypeId}" não está carregada — os valores aparecem como texto simples até ela voltar.
          </p>
        )}
        {mode === "edit" && field && field.type !== type && (
          <p className="hint warn">Os valores existentes serão convertidos quando possível; o que não converter fica vazio.</p>
        )}

        {(type === "select" || type === "multi_select") && (
          <div className="choices-editor">
            <label className="form-label">Opções</label>
            {choices.map((c, i) => (
              <div key={c.id} className="choice-row">
                <span
                  className="choice-dot"
                  style={{ background: c.color || CHOICE_COLORS[i % CHOICE_COLORS.length] }}
                  title="Trocar cor"
                  onClick={() => {
                    const cur = c.color || CHOICE_COLORS[i % CHOICE_COLORS.length];
                    const idx = CHOICE_COLORS.indexOf(cur);
                    const next = CHOICE_COLORS[(idx + 1) % CHOICE_COLORS.length];
                    setChoices(choices.map((x) => (x.id === c.id ? { ...x, color: next } : x)));
                  }}
                />
                <input
                  className="input"
                  value={c.name}
                  onChange={(e) => setChoices(choices.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))}
                />
                <button className="icon-btn" title="Remover" onClick={() => setChoices(choices.filter((x) => x.id !== c.id))}>
                  ×
                </button>
              </div>
            ))}
            <button
              className="btn btn-sm"
              onClick={() =>
                setChoices([...choices, { id: newChoiceId(), name: `Opção ${choices.length + 1}`, color: "" }])
              }
            >
              + Adicionar opção
            </button>
          </div>
        )}

        {type === "link" && (
          <>
            <label className="form-label">Tabela relacionada</label>
            <select className="input" value={targetTable} onChange={(e) => setTargetTable(e.target.value)}>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </>
        )}

        {type === "formula" && (
          <>
            <label className="form-label">Fórmula</label>
            <textarea
              className="input"
              rows={3}
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              placeholder={'ex.: IF({Preço} > 100, "caro", "barato")'}
            />
            <p className="hint">
              Referencie campos com {"{Nome do Campo}"}. Operadores: + - * / % &amp; = != &gt; &lt;. Funções: IF, AND,
              OR, NOT, CONCAT, UPPER, LOWER, TRIM, LEN, ROUND, ABS, MIN, MAX, TODAY, NOW, YEAR, MONTH, DAY, DAYS.
            </p>
          </>
        )}

        {type === "number" && (
          <>
            <label className="form-label">Formato</label>
            <select className="input" value={format} onChange={(e) => setFormat(e.target.value as NumberFormat)}>
              <option value="decimal">Decimal</option>
              <option value="integer">Inteiro</option>
              <option value="currency">Moeda (R$)</option>
              <option value="percent">Percentual (%)</option>
            </select>
            <label className="form-label">Casas decimais (vazio = automático)</label>
            <input
              className="input"
              inputMode="numeric"
              value={precision}
              onChange={(e) => setPrecision(e.target.value.replace(/\D/g, ""))}
              placeholder="ex.: 2"
            />
          </>
        )}

        {type === "rating" && (
          <>
            <label className="form-label">Máximo de estrelas (1–10)</label>
            <input
              className="input"
              inputMode="numeric"
              value={ratingMax}
              onChange={(e) => setRatingMax(e.target.value.replace(/\D/g, ""))}
              placeholder="5"
            />
          </>
        )}

        {(type === "lookup" || type === "rollup") &&
          (linkFields.length === 0 ? (
            <p className="hint warn">Crie antes um campo de Relação nesta tabela — lookup/rollup buscam valores através dele.</p>
          ) : (
            <>
              <label className="form-label">Através da relação</label>
              <select className="input" value={viaField?.id ?? ""} onChange={(e) => setLinkFieldId(e.target.value)}>
                {linkFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} → {tables.find((t) => t.id === f.options.tableId)?.name ?? "?"}
                  </option>
                ))}
              </select>
              <label className="form-label">Campo da tabela relacionada</label>
              <select className="input" value={targetFieldId} onChange={(e) => setTargetFieldId(e.target.value)}>
                {targetFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              {type === "rollup" && (
                <>
                  <label className="form-label">Agregação</label>
                  <select className="input" value={agg} onChange={(e) => setAgg(e.target.value as RollupAgg)}>
                    {(Object.keys(ROLLUP_AGG_LABEL) as RollupAgg[]).map((a) => (
                      <option key={a} value={a}>
                        {ROLLUP_AGG_LABEL[a]}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </>
          ))}

        {type === "date" && (
          <label className="check-label">
            <input type="checkbox" checked={includeTime} onChange={(e) => setIncludeTime(e.target.checked)} />
            Incluir hora
          </label>
        )}

        <label className="form-label">Descrição (opcional, aparece como dica)</label>
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="pra que serve este campo…"
        />

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn primary"
            disabled={busy || !name.trim() || ((type === "lookup" || type === "rollup") && !viaField) || (type === "custom" && !extTypeId)}
            onClick={() => void save()}
          >
            {mode === "new" ? "Criar campo" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}
