// Tela inicial: criar/abrir base e recentes. Uma base é um arquivo .tbase
// (SQLite comum — abre em qualquer ferramenta SQLite).

import { useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { inTauri } from "../lib/backend";
import { backupsDir } from "../lib/extensions";
import { backupKeep, dropRecent, readRecents, setBackupKeep, useStore } from "../state/store";

export function StartScreen() {
  const store = useStore();
  const [recents, setRecents] = useState(readRecents());
  const [keep, setKeep] = useState(backupKeep());
  const [customKeep, setCustomKeep] = useState(![0, 10, 50].includes(backupKeep()));
  const tauri = inTauri();

  const applyKeep = (n: number) => {
    setKeep(n);
    setBackupKeep(n);
  };

  const create = async () => {
    const path = await saveDialog({
      title: "Criar base de dados",
      defaultPath: "Minha base.tbase",
      filters: [{ name: "Base LocalData", extensions: ["tbase"] }],
    });
    if (path) await store.createBase(path);
  };

  const openFile = async () => {
    const path = await openDialog({
      title: "Abrir base de dados",
      filters: [
        { name: "Base LocalData", extensions: ["tbase"] },
        { name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] },
      ],
      multiple: false,
    });
    if (path && !Array.isArray(path)) await store.openBase(path);
  };

  return (
    <div className="start">
      <div className="start-card">
        <div className="start-logo">◩</div>
        <h1>LocalData</h1>
        <p className="muted">Banco de dados visual, 100% offline, com IA local.</p>
        <div className="start-features">
          <span className="feature-chip">▦ Grade</span>
          <span className="feature-chip">▤ Kanban</span>
          <span className="feature-chip">📅 Calendário</span>
          <span className="feature-chip">🖼 Galeria</span>
          <span className="feature-chip">📝 Formulário</span>
          <span className="feature-chip">↗ Relações + lookup</span>
          <span className="feature-chip">ƒx Fórmulas</span>
          <span className="feature-chip">⇄ XLSX/CSV</span>
          <span className="feature-chip">✦ IA local</span>
        </div>
        {!tauri && <p className="hint warn">Rodando no navegador — abra pelo app desktop pra usar os dados.</p>}
        <div className="start-actions">
          <button className="btn primary big" disabled={!tauri} onClick={() => void create()}>
            + Nova base
          </button>
          <button className="btn big" disabled={!tauri} onClick={() => void openFile()}>
            Abrir base…
          </button>
        </div>
        {recents.length > 0 && (
          <div className="start-recents">
            <div className="form-label">Recentes</div>
            {recents.map((p) => (
              <div key={p} className="recent-row">
                <button className="recent-btn" title={p} onClick={() => void store.openBase(p)}>
                  <span className="recent-name">{p.replace(/\\/g, "/").split("/").pop()}</span>
                  <span className="recent-path muted">{p}</span>
                </button>
                <button
                  className="icon-btn"
                  title="Remover dos recentes"
                  onClick={() => {
                    dropRecent(p);
                    setRecents(readRecents());
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {tauri && (
          <div className="start-backup muted">
            <span>Backup ao abrir: manter</span>
            <select
              className="input input-sm"
              value={customKeep ? "custom" : String(keep)}
              onChange={(e) => {
                if (e.target.value === "custom") {
                  setCustomKeep(true);
                } else {
                  setCustomKeep(false);
                  applyKeep(parseInt(e.target.value, 10));
                }
              }}
            >
              <option value="0">nenhuma (desligado)</option>
              <option value="10">10 cópias</option>
              <option value="50">50 cópias</option>
              <option value="custom">personalizado…</option>
            </select>
            {customKeep && (
              <input
                className="input input-sm w60"
                inputMode="numeric"
                value={keep}
                onChange={(e) => applyKeep(parseInt(e.target.value.replace(/\D/g, ""), 10) || 0)}
              />
            )}
            <button
              className="btn btn-sm"
              title="Abrir a pasta onde os backups ficam"
              onClick={() => void backupsDir().then(openPath).catch(() => {})}
            >
              📂 Backups
            </button>
          </div>
        )}
        <p className="start-foot muted">O arquivo .tbase é um SQLite comum — seus dados são seus.</p>
      </div>
    </div>
  );
}
