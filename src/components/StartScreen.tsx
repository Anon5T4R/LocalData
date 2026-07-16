// Tela inicial: criar/abrir base e recentes. Uma base é um arquivo .tbase
// (SQLite comum — abre em qualquer ferramenta SQLite).

import { useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { inTauri } from "../lib/backend";
import { backupsDir } from "../lib/extensions";
import { useRemote } from "../lib/remote";
import { backupKeep, dropRecent, readRecents, setBackupKeep, useStore } from "../state/store";
import { t } from "../lib/i18n";

export function StartScreen() {
  const store = useStore();
  const remote = useRemote();
  const [recents, setRecents] = useState(readRecents());
  const [keep, setKeep] = useState(backupKeep());
  const [customKeep, setCustomKeep] = useState(![0, 10, 50].includes(backupKeep()));
  const [showConnect, setShowConnect] = useState(false);
  const [srvUrl, setSrvUrl] = useState(localStorage.getItem("localdata.remote.url") ?? "");
  const [srvUser, setSrvUser] = useState("");
  const [srvPass, setSrvPass] = useState("");
  const tauri = inTauri();

  const connect = async () => {
    const ok = await remote.connect(srvUrl, srvUser, srvPass);
    if (ok) {
      setSrvPass("");
      await store.openRemoteBase();
    }
  };

  const applyKeep = (n: number) => {
    setKeep(n);
    setBackupKeep(n);
  };

  const create = async () => {
    const path = await saveDialog({
      title: t("start.createTitle"),
      defaultPath: t("start.createDefaultName"),
      filters: [{ name: t("start.filterBase"), extensions: ["tbase"] }],
    });
    if (path) await store.createBase(path);
  };

  const openFile = async () => {
    const path = await openDialog({
      title: t("start.openTitle"),
      filters: [
        { name: t("start.filterBase"), extensions: ["tbase"] },
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
        <p className="muted">{t("start.tagline")}</p>
        <div className="start-features">
          <span className="feature-chip">{t("start.feat.grid")}</span>
          <span className="feature-chip">{t("start.feat.kanban")}</span>
          <span className="feature-chip">{t("start.feat.calendar")}</span>
          <span className="feature-chip">{t("start.feat.gallery")}</span>
          <span className="feature-chip">{t("start.feat.form")}</span>
          <span className="feature-chip">{t("start.feat.link")}</span>
          <span className="feature-chip">{t("start.feat.formula")}</span>
          <span className="feature-chip">{t("start.feat.io")}</span>
          <span className="feature-chip">{t("start.feat.ai")}</span>
        </div>
        {!tauri && <p className="hint warn">{t("start.browserWarn")}</p>}
        <div className="start-actions">
          <button className="btn primary big" disabled={!tauri} onClick={() => void create()}>
            {t("start.newBase")}
          </button>
          <button className="btn big" disabled={!tauri} onClick={() => void openFile()}>
            {t("start.openBase")}
          </button>
          <button className="btn big" disabled={!tauri} onClick={() => setShowConnect(!showConnect)}>
            {t("start.connect")}
          </button>
        </div>

        {showConnect && (
          <div className="connect-box">
            <div className="form-label">{t("start.serverLabel")}</div>
            <input
              className="input input-sm"
              placeholder="192.168.0.10:8787"
              value={srvUrl}
              onChange={(e) => setSrvUrl(e.target.value)}
            />
            <div className="pop-row">
              <input
                className="input input-sm"
                placeholder={t("start.user")}
                value={srvUser}
                onChange={(e) => setSrvUser(e.target.value)}
              />
              <input
                className="input input-sm"
                type="password"
                placeholder={t("start.pass")}
                value={srvPass}
                onChange={(e) => setSrvPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void connect()}
              />
            </div>
            {remote.error && <div className="ai-err">{remote.error}</div>}
            <button
              className="btn btn-sm primary"
              disabled={remote.connecting || !srvUrl.trim() || !srvUser.trim()}
              onClick={() => void connect()}
            >
              {remote.connecting ? t("start.connecting") : t("start.connectBtn")}
            </button>
          </div>
        )}
        {recents.length > 0 && (
          <div className="start-recents">
            <div className="form-label">{t("start.recents")}</div>
            {recents.map((p) => (
              <div key={p} className="recent-row">
                <button className="recent-btn" title={p} onClick={() => void store.openBase(p)}>
                  <span className="recent-name">{p.replace(/\\/g, "/").split("/").pop()}</span>
                  <span className="recent-path muted">{p}</span>
                </button>
                <button
                  className="icon-btn"
                  title={t("start.removeRecent")}
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
            <span>{t("start.backupKeep")}</span>
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
              <option value="0">{t("start.backupNone")}</option>
              <option value="10">{t("start.backup10")}</option>
              <option value="50">{t("start.backup50")}</option>
              <option value="custom">{t("start.backupCustom")}</option>
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
              title={t("start.backupFolderTitle")}
              onClick={() => void backupsDir().then(openPath).catch(() => {})}
            >
              {t("start.backups")}
            </button>
          </div>
        )}
        <p className="start-foot muted">{t("start.foot")}</p>
      </div>
    </div>
  );
}
