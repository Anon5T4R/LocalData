// Painel do modo servidor (🌐): hospedar a base pra rede local, gerir usuários
// e permissões por tabela. Só faz sentido com a base aberta LOCALMENTE (não
// quando você é o cliente remoto de outra máquina).

import { useEffect, useState } from "react";
import * as api from "../lib/backend";
import { isRemote } from "../lib/remote";
import { useStore } from "../state/store";
import { t as tr } from "../lib/i18n";

type Tab = "serve" | "users";

export function ServerPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const [tab, setTab] = useState<Tab>("users");
  const [status, setStatus] = useState<api.ServerStatus | null>(null);
  const [port, setPort] = useState(localStorage.getItem("localdata.serverPort") ?? "8787");
  const [users, setUsers] = useState<api.UserInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const tables = store.schema?.tables ?? [];

  const loadUsers = async () => {
    try {
      setUsers(await api.usersList());
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    void api.serverStatus().then(setStatus).catch(() => {});
    void loadUsers();
  }, []);

  const startStop = async () => {
    setErr("");
    setBusy(true);
    try {
      if (status?.running) {
        await api.serverStop();
        setStatus(await api.serverStatus());
      } else {
        localStorage.setItem("localdata.serverPort", port);
        const s = await api.serverStart(parseInt(port, 10) || 8787);
        setStatus(s);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal server-panel">
        <div className="record-modal-head">
          <h3>{tr("srv.title")}</h3>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>

        {isRemote() ? (
          <p className="hint warn">{tr("srv.remoteWarn")}</p>
        ) : (
          <>
            <div className="server-tabs">
              <button className={"tab-btn" + (tab === "users" ? " active" : "")} onClick={() => setTab("users")}>
                {tr("srv.tabUsers")}
              </button>
              <button className={"tab-btn" + (tab === "serve" ? " active" : "")} onClick={() => setTab("serve")}>
                {tr("srv.tabServe")}
              </button>
            </div>

            {err && <div className="ai-err">{err}</div>}

            {tab === "serve" && (
              <div className="server-serve">
                <p className="muted">{tr("srv.serveDesc")}</p>
                <div className="pop-row">
                  <label className="form-label">{tr("srv.port")}</label>
                  <input
                    className="input input-sm w80"
                    value={port}
                    disabled={status?.running}
                    onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                  />
                  <button className={"btn btn-sm" + (status?.running ? " danger" : " primary")} disabled={busy} onClick={() => void startStop()}>
                    {status?.running ? tr("srv.stopServe") : tr("srv.startServe")}
                  </button>
                </div>
                {status?.running && (
                  <div className="serve-info">
                    <div>
                      {tr("srv.servingAt")} <strong>http://{status.lanIp}:{status.port}</strong>
                    </div>
                    <div className="muted">{tr("srv.serveAddrNote")}</div>
                  </div>
                )}
                {!users.some((u) => u.role === "admin") && (
                  <p className="hint warn">{tr("srv.needAdmin")}</p>
                )}
              </div>
            )}

            {tab === "users" && (
              <UsersTab users={users} tables={tables} reload={loadUsers} setErr={setErr} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function UsersTab({
  users,
  tables,
  reload,
  setErr,
}: {
  users: api.UserInfo[];
  tables: { id: string; name: string }[];
  reload: () => Promise<void>;
  setErr: (s: string) => void;
}) {
  const [editing, setEditing] = useState<Partial<api.UserInfo> & { password?: string } | null>(null);

  const save = async () => {
    if (!editing?.name?.trim()) return;
    try {
      await api.userSave({
        id: editing.id,
        name: editing.name.trim(),
        role: editing.role ?? "editor",
        password: editing.password,
      });
      setEditing(null);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const setPerm = async (userId: string, tableId: string, level: string) => {
    try {
      await api.userSetPerm(userId, tableId, level);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="users-tab">
      <p className="muted">
        {tr("srv.rolesLabel")}: <strong>leitor</strong> {tr("srv.roleReader")}, <strong>editor</strong>{" "}
        {tr("srv.roleEditor")}, <strong>admin</strong> {tr("srv.roleAdmin")}. {tr("srv.rolesTune")}
      </p>
      <table className="users-table">
        <thead>
          <tr>
            <th>{tr("srv.colName")}</th>
            <th>{tr("srv.colRole")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.role}</td>
              <td className="users-actions">
                <button className="icon-btn" title={tr("common.edit")} onClick={() => setEditing({ ...u, password: "" })}>
                  ✏️
                </button>
                <button
                  className="icon-btn"
                  title={tr("common.delete")}
                  onClick={() => {
                    if (confirm(tr("srv.deleteUserConfirm", { name: u.name }))) void api.userDelete(u.id).then(reload);
                  }}
                >
                  🗑
                </button>
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                {tr("srv.noUsers")}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <button className="btn btn-sm" onClick={() => setEditing({ role: "editor", password: "" })}>
        {tr("srv.newUser")}
      </button>

      {editing && (
        <div className="user-editor">
          <div className="pop-row">
            <input
              className="input input-sm"
              placeholder={tr("srv.userNamePlaceholder")}
              value={editing.name ?? ""}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
            <select
              className="input input-sm"
              value={editing.role ?? "editor"}
              onChange={(e) => setEditing({ ...editing, role: e.target.value as api.UserInfo["role"] })}
            >
              <option value="leitor">leitor</option>
              <option value="editor">editor</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <input
            className="input input-sm"
            type="password"
            placeholder={editing.id ? tr("srv.newPassPlaceholder") : tr("srv.passPlaceholder")}
            value={editing.password ?? ""}
            onChange={(e) => setEditing({ ...editing, password: e.target.value })}
          />

          {editing.id && tables.length > 0 && (
            <div className="perm-grid">
              <div className="form-label">{tr("srv.permTitle")}</div>
              {tables.map((t) => (
                <div key={t.id} className="pop-row">
                  <span className="perm-table">{t.name}</span>
                  <select
                    className="input input-sm"
                    value={editing.perms?.[t.id] ?? ""}
                    onChange={(e) => void setPerm(editing.id!, t.id, e.target.value)}
                  >
                    <option value="">{tr("srv.permDefault")}</option>
                    <option value="none">{tr("srv.permNone")}</option>
                    <option value="read">{tr("srv.permRead")}</option>
                    <option value="edit">{tr("srv.permEdit")}</option>
                  </select>
                </div>
              ))}
            </div>
          )}

          <div className="modal-actions">
            <button className="btn btn-sm" onClick={() => setEditing(null)}>
              {tr("common.cancel")}
            </button>
            <button className="btn btn-sm primary" onClick={() => void save()}>
              {tr("common.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
