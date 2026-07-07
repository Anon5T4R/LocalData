// Conexão a um LocalData remoto (modo servidor multiusuário).
//
// Quando conectado, os comandos de DADOS e SCHEMA vão por HTTP pro host em vez
// do backend local (ver backend.ts `call`). O host é outra máquina rodando o
// LocalData com "Servir" ligado. Autenticação por usuário/senha → token.

import { create } from "zustand";

export interface RemoteSession {
  url: string; // http://host:porta
  token: string;
  name: string;
  role: "leitor" | "editor" | "admin";
}

interface RemoteState {
  session: RemoteSession | null;
  connecting: boolean;
  error: string | null;
  connect(url: string, name: string, password: string): Promise<boolean>;
  disconnect(): Promise<void>;
  setError(e: string | null): void;
}

function normalizeUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  // host sem porta → porta padrão do servidor
  if (!/:\d+$/.test(u.replace(/^https?:\/\//i, ""))) u += ":8787";
  return u;
}

export const useRemote = create<RemoteState>((set, get) => ({
  session: null,
  connecting: false,
  error: null,

  async connect(url, name, password) {
    const base = normalizeUrl(url);
    set({ connecting: true, error: null });
    try {
      const res = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        throw new Error(body.error || `servidor respondeu ${res.status}`);
      }
      const r = body.result;
      set({
        session: { url: base, token: r.token, name: r.name, role: r.role },
        connecting: false,
      });
      localStorage.setItem("localdata.remote.url", base);
      return true;
    } catch (e) {
      set({ connecting: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  async disconnect() {
    const s = get().session;
    if (s) {
      try {
        await fetch(`${s.url}/api/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${s.token}` },
        });
      } catch {
        /* melhor esforço */
      }
    }
    set({ session: null, error: null });
  },

  setError(e) {
    set({ error: e });
  },
}));

/** Chama um comando no host remoto. Lança em erro (mesma forma do invoke). */
export async function remoteCall<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const s = useRemote.getState().session;
  if (!s) throw new Error("sem conexão remota");
  const res = await fetch(`${s.url}/api/cmd/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // sessão expirou/servidor reiniciou: derruba a conexão
    useRemote.setState({ session: null, error: "sessão encerrada pelo servidor — conecte de novo" });
    throw new Error("sessão encerrada pelo servidor");
  }
  if (!res.ok || !body.ok) {
    throw new Error(body.error || `servidor respondeu ${res.status}`);
  }
  return body.result as T;
}

export function isRemote(): boolean {
  return useRemote.getState().session != null;
}

export function myRole(): string {
  return useRemote.getState().session?.role ?? "admin"; // local = dono = admin
}
