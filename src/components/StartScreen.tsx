// Tela inicial: criar/abrir base e recentes. Uma base é um arquivo .tbase
// (SQLite comum — abre em qualquer ferramenta SQLite).

import { useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { inTauri } from "../lib/backend";
import { dropRecent, readRecents, useStore } from "../state/store";

export function StartScreen() {
  const store = useStore();
  const [recents, setRecents] = useState(readRecents());
  const tauri = inTauri();

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
        <p className="start-foot muted">O arquivo .tbase é um SQLite comum — seus dados são seus.</p>
      </div>
    </div>
  );
}
