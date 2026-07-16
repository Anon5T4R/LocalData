// Importar planilha PARA a tabela ativa, atualizando registros por um
// campo-chave (upsert). Colunas casam por nome de cabeçalho.

import { useState } from "react";
import { activeTable, useStore } from "../state/store";
import { pickSheet, upsertImport, type SheetData, type UpsertResult } from "../lib/importer";
import { isComputed } from "../lib/types";
import { t } from "../lib/i18n";

export function ImportModal({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const table = activeTable(store);
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [keyField, setKeyField] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpsertResult | null>(null);
  const [err, setErr] = useState("");

  if (!table) return null;

  const norm = (s: string) => s.trim().toLowerCase();
  // campos que existem como coluna na planilha e podem ser chave
  const keyCandidates = table.fields.filter(
    (f) => !isComputed(f.type) && f.type !== "attachment" && f.type !== "link" && f.type !== "multi_select"
  );
  const matched = sheet ? table.fields.filter((f) => sheet.headers.some((h) => norm(h) === norm(f.name))) : [];

  const choose = async () => {
    setErr("");
    try {
      const s = await pickSheet();
      if (!s) return;
      setSheet(s);
      setResult(null);
      // sugere a 1ª coluna que bate com um campo candidato a chave
      const guess = keyCandidates.find((f) => s.headers.some((h) => norm(h) === norm(f.name)));
      setKeyField(guess?.id ?? "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async () => {
    if (!sheet || !keyField) return;
    setBusy(true);
    setErr("");
    try {
      const r = await upsertImport(store, table, sheet, keyField);
      setResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal import-modal">
        <div className="record-modal-head">
          <h3>{t("im.title", { name: table.name })}</h3>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <p className="muted">{t("im.desc")}</p>

        <button className="btn btn-sm" onClick={() => void choose()}>
          {sheet ? t("im.change") : t("im.choose")}
        </button>

        {err && <div className="ai-err">{err}</div>}

        {sheet && (
          <>
            <div className="import-summary muted">
              {t("im.summary", {
                cols: sheet.headers.length,
                rows: sheet.body.length,
                matched: matched.length ? matched.map((f) => f.name).join(", ") : t("im.noMatch"),
              })}
            </div>
            <label className="form-label">{t("im.matchBy")}</label>
            <select className="input input-sm" value={keyField} onChange={(e) => setKeyField(e.target.value)}>
              <option value="">{t("im.chooseKey")}</option>
              {keyCandidates.map((f) => {
                const inSheet = sheet.headers.some((h) => norm(h) === norm(f.name));
                return (
                  <option key={f.id} value={f.id} disabled={!inSheet}>
                    {f.name}
                    {inSheet ? "" : t("im.notInSheet")}
                  </option>
                );
              })}
            </select>

            {result && (
              <div className="import-result">
                {t("im.result", { updated: result.updated, created: result.created })}
                {result.skipped ? t("im.resultSkipped", { skipped: result.skipped }) : ""}.
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {result ? t("common.close") : t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!sheet || !keyField || busy} onClick={() => void run()}>
            {busy ? t("im.importing") : t("im.import")}
          </button>
        </div>
      </div>
    </div>
  );
}
