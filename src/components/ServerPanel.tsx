// Painel do modo servidor (🌐): hospedar a base pra rede local, gerir usuários
// e permissões por tabela. Só faz sentido com a base aberta LOCALMENTE (não
// quando você é o cliente remoto de outra máquina).

import { useEffect, useState } from "react";
import * as api from "../lib/backend";
import { isRemote } from "../lib/remote";
import { useStore } from "../state/store";

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
          <h3>🌐 Servidor multiusuário</h3>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>

        {isRemote() ? (
          <p className="hint warn">
            Você está conectado a um servidor remoto. A administração de usuários e o modo "servir" ficam na máquina
            que hospeda a base.
          </p>
        ) : (
          <>
            <div className="server-tabs">
              <button className={"tab-btn" + (tab === "users" ? " active" : "")} onClick={() => setTab("users")}>
                Usuários
              </button>
              <button className={"tab-btn" + (tab === "serve" ? " active" : "")} onClick={() => setTab("serve")}>
                Servir
              </button>
            </div>

            {err && <div className="ai-err">{err}</div>}

            {tab === "serve" && (
              <div className="server-serve">
                <p className="muted">
                  Ligue o servidor pra outras pessoas na mesma rede abrirem ESTA base pelo LocalData delas (menu
                  "Conectar a um servidor" na tela inicial). Enquanto servir, mantenha o LocalData aberto aqui.
                </p>
                <div className="pop-row">
                  <label className="form-label">Porta</label>
                  <input
                    className="input input-sm w80"
                    value={port}
                    disabled={status?.running}
                    onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                  />
                  <button className={"btn btn-sm" + (status?.running ? " danger" : " primary")} disabled={busy} onClick={() => void startStop()}>
                    {status?.running ? "Parar de servir" : "Começar a servir"}
                  </button>
                </div>
                {status?.running && (
                  <div className="serve-info">
                    <div>
                      Servindo em <strong>http://{status.lanIp}:{status.port}</strong>
                    </div>
                    <div className="muted">É esse endereço que os colegas digitam em "Conectar a um servidor".</div>
                  </div>
                )}
                {!users.some((u) => u.role === "admin") && (
                  <p className="hint warn">Cadastre um usuário admin (aba Usuários) antes de servir.</p>
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
        Papéis: <strong>leitor</strong> só vê, <strong>editor</strong> edita registros, <strong>admin</strong> mexe em
        tudo (estrutura e usuários). Dá pra afinar por tabela abaixo.
      </p>
      <table className="users-table">
        <thead>
          <tr>
            <th>Nome</th>
            <th>Papel</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.role}</td>
              <td className="users-actions">
                <button className="icon-btn" title="Editar" onClick={() => setEditing({ ...u, password: "" })}>
                  ✏️
                </button>
                <button
                  className="icon-btn"
                  title="Excluir"
                  onClick={() => {
                    if (confirm(`Excluir o usuário "${u.name}"?`)) void api.userDelete(u.id).then(reload);
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
                Nenhum usuário — crie o primeiro (admin) abaixo.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <button className="btn btn-sm" onClick={() => setEditing({ role: "editor", password: "" })}>
        + Novo usuário
      </button>

      {editing && (
        <div className="user-editor">
          <div className="pop-row">
            <input
              className="input input-sm"
              placeholder="Nome de usuário"
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
            placeholder={editing.id ? "Nova senha (vazio mantém)" : "Senha"}
            value={editing.password ?? ""}
            onChange={(e) => setEditing({ ...editing, password: e.target.value })}
          />

          {editing.id && tables.length > 0 && (
            <div className="perm-grid">
              <div className="form-label">Permissão por tabela (sobrepõe o papel)</div>
              {tables.map((t) => (
                <div key={t.id} className="pop-row">
                  <span className="perm-table">{t.name}</span>
                  <select
                    className="input input-sm"
                    value={editing.perms?.[t.id] ?? ""}
                    onChange={(e) => void setPerm(editing.id!, t.id, e.target.value)}
                  >
                    <option value="">(padrão do papel)</option>
                    <option value="none">sem acesso</option>
                    <option value="read">só leitura</option>
                    <option value="edit">edição</option>
                  </select>
                </div>
              ))}
            </div>
          )}

          <div className="modal-actions">
            <button className="btn btn-sm" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button className="btn btn-sm primary" onClick={() => void save()}>
              Salvar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
