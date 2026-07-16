// Criar/editar campo: nome, tipo e opções específicas do tipo.
// Mudança de tipo converte os valores existentes no backend (melhor esforço).

import { useState } from "react";
import { activeTable, useStore } from "../state/store";
import type { Choice, Field, FieldOptions, FieldType, NumberFormat, RollupAgg } from "../lib/types";
import { CHOICE_COLORS, FIELD_TYPES, ROLLUP_AGGS, fieldTypeLabel, rollupAggLabel, isComputed } from "../lib/types";
import { useExtensions } from "../lib/extensions";
import { t as tr } from "../lib/i18n";

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
  const [ratingMax, setRatingMax] = useState(field?.options.ratingMax?.toString() ?? "5");
  const [linkFieldId, setLinkFieldId] = useState(field?.options.linkFieldId ?? "");
  const [targetFieldId, setTargetFieldId] = useState(field?.options.targetFieldId ?? "");
  const [agg, setAgg] = useState<RollupAgg>(field?.options.agg ?? "count");
  const [extTypeId, setExtTypeId] = useState(field?.options.extType ?? "");
  const [description, setDescription] = useState(field?.options.description ?? "");
  const [unique, setUnique] = useState(field?.options.unique ?? false);
  const [required, setRequired] = useState(field?.options.required ?? false);
  const [regex, setRegex] = useState(field?.options.regex ?? "");
  const [cmin, setCmin] = useState(field?.options.min != null ? String(field.options.min) : "");
  const [cmax, setCmax] = useState(field?.options.max != null ? String(field.options.max) : "");
  const [onDelete, setOnDelete] = useState<"restrict" | "unlink">(field?.options.onDelete ?? "unlink");
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
    if (type === "rating") o.ratingMax = Math.max(1, Math.min(10, parseInt(ratingMax, 10) || 5));
    if (type === "lookup" || type === "rollup") {
      o.linkFieldId = viaField?.id ?? "";
      o.targetFieldId = targetFields.some((f) => f.id === targetFieldId) ? targetFieldId : targetFields[0]?.id ?? "";
      if (type === "rollup") o.agg = agg;
    }
    if (type === "custom") o.extType = extTypeId;
    // --- constraints ---
    const numberLike = type === "number" || type === "rating";
    const textLike = ["text", "long_text", "url", "email", "phone", "custom"].includes(type);
    if (unique && !isComputed(type) && type !== "checkbox" && type !== "attachment" && type !== "multi_select") {
      o.unique = true;
    }
    if (required && !isComputed(type)) o.required = true;
    if (textLike && regex.trim()) o.regex = regex.trim();
    if (numberLike) {
      if (cmin !== "") o.min = parseFloat(cmin.replace(",", "."));
      if (cmax !== "" && type === "number") o.max = parseFloat(cmax.replace(",", "."));
    }
    if (type === "date") {
      if (cmin) o.min = cmin;
      if (cmax) o.max = cmax;
    }
    if (type === "link") o.onDelete = onDelete;
    if (description.trim()) o.description = description.trim();
    return o;
  };

  const numberLike = type === "number" || type === "rating";
  const textLike = ["text", "long_text", "url", "email", "phone", "custom"].includes(type);
  const canUnique = !isComputed(type) && !["checkbox", "attachment", "multi_select"].includes(type);
  const canConstrain = !isComputed(type);

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
        <h3>{mode === "new" ? tr("fe.newField") : tr("fe.editField")}</h3>

        <label className="form-label">{tr("common.name")}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={tr("fe.namePlaceholder")} />

        <label className="form-label">{tr("fe.type")}</label>
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
          {FIELD_TYPES.filter((t) => t !== "custom").map((t) => (
            <option key={t} value={t}>
              {fieldTypeLabel(t)}
            </option>
          ))}
          {(extTypes.length > 0 || orphanExt) && (
            <optgroup label={tr("fe.extGroup")}>
              {extTypes.map((e) => (
                <option key={e.id} value={`custom:${e.id}`}>
                  {e.icon ? `${e.icon} ` : ""}{e.name}
                </option>
              ))}
              {orphanExt && (
                <option value={`custom:${orphanExt}`}>{tr("fe.extNotLoadedOpt", { ext: orphanExt })}</option>
              )}
            </optgroup>
          )}
        </select>
        {type === "custom" && selectedExt?.description && <p className="hint">{selectedExt.description}</p>}
        {type === "custom" && !selectedExt && (
          <p className="hint warn">{tr("fe.extNotLoaded", { ext: extTypeId })}</p>
        )}
        {mode === "edit" && field && field.type !== type && (
          <p className="hint warn">{tr("fe.convertWarn")}</p>
        )}

        {(type === "select" || type === "multi_select") && (
          <div className="choices-editor">
            <label className="form-label">{tr("fe.options")}</label>
            {choices.map((c, i) => (
              <div key={c.id} className="choice-row">
                <span
                  className="choice-dot"
                  style={{ background: c.color || CHOICE_COLORS[i % CHOICE_COLORS.length] }}
                  title={tr("fe.changeColor")}
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
                <button className="icon-btn" title={tr("common.remove")} onClick={() => setChoices(choices.filter((x) => x.id !== c.id))}>
                  ×
                </button>
              </div>
            ))}
            <button
              className="btn btn-sm"
              onClick={() =>
                setChoices([...choices, { id: newChoiceId(), name: tr("fe.optionDefault", { n: choices.length + 1 }), color: "" }])
              }
            >
              {tr("fe.addOption")}
            </button>
          </div>
        )}

        {type === "link" && (
          <>
            <label className="form-label">{tr("fe.relatedTable")}</label>
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
            <label className="form-label">{tr("fe.formula")}</label>
            <textarea
              className="input"
              rows={3}
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              placeholder={tr("fe.formulaPlaceholder")}
            />
            <p className="hint">{tr("fe.formulaHint")}</p>
          </>
        )}

        {type === "number" && (
          <>
            <label className="form-label">{tr("fe.numFormat")}</label>
            <select className="input" value={format} onChange={(e) => setFormat(e.target.value as NumberFormat)}>
              <option value="decimal">{tr("fe.fmtDecimal")}</option>
              <option value="integer">{tr("fe.fmtInteger")}</option>
              <option value="currency">{tr("fe.fmtCurrency")}</option>
              <option value="percent">{tr("fe.fmtPercent")}</option>
            </select>
            <label className="form-label">{tr("fe.decimals")}</label>
            <input
              className="input"
              inputMode="numeric"
              value={precision}
              onChange={(e) => setPrecision(e.target.value.replace(/\D/g, ""))}
              placeholder={tr("fe.decimalsPlaceholder")}
            />
          </>
        )}

        {type === "rating" && (
          <>
            <label className="form-label">{tr("fe.ratingMax")}</label>
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
            <p className="hint warn">{tr("fe.needLink")}</p>
          ) : (
            <>
              <label className="form-label">{tr("fe.viaLink")}</label>
              <select className="input" value={viaField?.id ?? ""} onChange={(e) => setLinkFieldId(e.target.value)}>
                {linkFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} → {tables.find((t) => t.id === f.options.tableId)?.name ?? "?"}
                  </option>
                ))}
              </select>
              <label className="form-label">{tr("fe.targetField")}</label>
              <select className="input" value={targetFieldId} onChange={(e) => setTargetFieldId(e.target.value)}>
                {targetFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              {type === "rollup" && (
                <>
                  <label className="form-label">{tr("fe.agg")}</label>
                  <select className="input" value={agg} onChange={(e) => setAgg(e.target.value as RollupAgg)}>
                    {ROLLUP_AGGS.map((a) => (
                      <option key={a} value={a}>
                        {rollupAggLabel(a)}
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
            {tr("fe.includeTime")}
          </label>
        )}

        {type === "link" && (
          <>
            <label className="form-label">{tr("fe.onDelete")}</label>
            <select className="input" value={onDelete} onChange={(e) => setOnDelete(e.target.value as "restrict" | "unlink")}>
              <option value="unlink">{tr("fe.unlink")}</option>
              <option value="restrict">{tr("fe.restrict")}</option>
            </select>
          </>
        )}

        {canConstrain && (
          <div className="constraints-box">
            <div className="form-label">{tr("fe.validation")}</div>
            {canUnique && (
              <label className="check-label">
                <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
                {tr("fe.unique")}
              </label>
            )}
            <label className="check-label">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
              {tr("fe.required")}
            </label>
            {textLike && (
              <>
                <label className="form-label">{tr("fe.regex")}</label>
                <input
                  className="input"
                  value={regex}
                  onChange={(e) => setRegex(e.target.value)}
                  placeholder="ex.: ^[A-Z]{3}-\d{4}$"
                />
              </>
            )}
            {(numberLike || type === "date") && (
              <div className="pop-row">
                <label className="form-label">{tr("fe.min")}</label>
                <input
                  className="input input-sm w80"
                  type={type === "date" ? "date" : "text"}
                  inputMode={numberLike ? "decimal" : undefined}
                  value={cmin}
                  onChange={(e) => setCmin(e.target.value)}
                />
                <label className="form-label">{tr("fe.max")}</label>
                <input
                  className="input input-sm w80"
                  type={type === "date" ? "date" : "text"}
                  inputMode={numberLike ? "decimal" : undefined}
                  value={cmax}
                  onChange={(e) => setCmax(e.target.value)}
                  disabled={type === "rating"}
                />
              </div>
            )}
          </div>
        )}

        <label className="form-label">{tr("fe.description")}</label>
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={tr("fe.descPlaceholder")}
        />

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {tr("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={busy || !name.trim() || ((type === "lookup" || type === "rollup") && !viaField) || (type === "custom" && !extTypeId)}
            onClick={() => void save()}
          >
            {mode === "new" ? tr("fe.create") : tr("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
