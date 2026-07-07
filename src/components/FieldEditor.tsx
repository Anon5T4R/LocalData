// Criar/editar campo: nome, tipo e opções específicas do tipo.
// Mudança de tipo converte os valores existentes no backend (melhor esforço).

import { useState } from "react";
import { activeTable, useStore } from "../state/store";
import type { Choice, Field, FieldOptions, FieldType } from "../lib/types";
import { CHOICE_COLORS, FIELD_TYPE_LABEL } from "../lib/types";

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
  const [includeTime, setIncludeTime] = useState(field?.options.includeTime ?? false);
  const [busy, setBusy] = useState(false);

  if (!table) return null;

  const buildOptions = (): FieldOptions => {
    const o: FieldOptions = {};
    if (type === "select" || type === "multi_select") o.choices = choices;
    if (type === "link") o.tableId = targetTable;
    if (type === "formula") o.expr = expr;
    if (type === "number" && precision !== "") o.precision = Math.max(0, Math.min(8, parseInt(precision, 10) || 0));
    if (type === "date") o.includeTime = includeTime;
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
        <select className="input" value={type} onChange={(e) => setType(e.target.value as FieldType)}>
          {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
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

        {type === "date" && (
          <label className="check-label">
            <input type="checkbox" checked={includeTime} onChange={(e) => setIncludeTime(e.target.checked)} />
            Incluir hora
          </label>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {mode === "new" ? "Criar campo" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}
