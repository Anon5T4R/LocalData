// Importar planilha PARA a tabela ativa, atualizando registros por um
// campo-chave (upsert). Colunas casam por nome de cabeçalho.

import { useState } from "react";
import { activeTable, useStore } from "../state/store";
import { pickSheet, upsertImport, type SheetData, type UpsertResult } from "../lib/importer";
import { isComputed } from "../lib/types";

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
          <h3>Importar/atualizar — {table.name}</h3>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <p className="muted">
          Atualiza esta tabela a partir de uma planilha: linhas cujo campo-chave já existe são atualizadas, as demais
          viram registros novos. As colunas casam pelo nome do cabeçalho.
        </p>

        <button className="btn btn-sm" onClick={() => void choose()}>
          {sheet ? "Trocar arquivo…" : "📥 Escolher planilha…"}
        </button>

        {err && <div className="ai-err">{err}</div>}

        {sheet && (
          <>
            <div className="import-summary muted">
              {sheet.headers.length} colunas, {sheet.body.length} linhas. Casam com campos:{" "}
              {matched.length ? matched.map((f) => f.name).join(", ") : "nenhuma (confira os cabeçalhos)"}.
            </div>
            <label className="form-label">Casar registros por</label>
            <select className="input input-sm" value={keyField} onChange={(e) => setKeyField(e.target.value)}>
              <option value="">— escolha o campo-chave —</option>
              {keyCandidates.map((f) => {
                const inSheet = sheet.headers.some((h) => norm(h) === norm(f.name));
                return (
                  <option key={f.id} value={f.id} disabled={!inSheet}>
                    {f.name}
                    {inSheet ? "" : " (não está na planilha)"}
                  </option>
                );
              })}
            </select>

            {result && (
              <div className="import-result">
                ✓ {result.updated} atualizado(s), {result.created} criado(s)
                {result.skipped ? `, ${result.skipped} sem chave ignorado(s)` : ""}.
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {result ? "Fechar" : "Cancelar"}
          </button>
          <button className="btn primary" disabled={!sheet || !keyField || busy} onClick={() => void run()}>
            {busy ? "Importando…" : "Importar"}
          </button>
        </div>
      </div>
    </div>
  );
}
