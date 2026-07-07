// Painel de IA local (padrão da suíte): escolhe modelo GGUF, sobe o sidecar
// llama-server e conversa. Respostas com bloco ```json de operações são
// validadas contra o schema e aplicadas (ai.ts).

import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as ai from "../lib/ai";
import { inTauri } from "../lib/backend";
import { activeTable, useStore } from "../state/store";
import { invalidateLinkLabels } from "./cells";

const K = {
  dir: "localdata.ai.dir",
  model: "localdata.ai.model",
  ngl: "localdata.ai.ngl",
  ctx: "localdata.ai.ctx",
};

interface Msg {
  role: "user" | "assistant" | "note";
  content: string;
}

export function AiPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const [dir, setDir] = useState(localStorage.getItem(K.dir) ?? "");
  const [models, setModels] = useState<ai.ModelInfo[]>([]);
  const [model, setModel] = useState(localStorage.getItem(K.model) ?? "");
  const [ngl, setNgl] = useState(localStorage.getItem(K.ngl) ?? "0");
  const [ctx, setCtx] = useState(localStorage.getItem(K.ctx) ?? "4096");
  const [port, setPort] = useState(0);
  const [phase, setPhase] = useState<"idle" | "starting" | "ready" | "thinking">("idle");
  const [err, setErr] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [showConfig, setShowConfig] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // já tem servidor de outra sessão do painel?
    ai.llmStatus()
      .then((s) => {
        if (s.running) {
          setPort(s.port);
          setPhase("ready");
          setShowConfig(false);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs]);

  const scan = async (dirOverride?: string) => {
    const d = dirOverride ?? dir;
    if (!d.trim()) return;
    setErr("");
    try {
      localStorage.setItem(K.dir, d);
      const found = await ai.listModels(d);
      const usable = found.filter((m) => !m.is_projector);
      setModels(usable);
      if (usable.length && !usable.some((m) => m.path === model)) setModel(usable[0].path);
      if (!usable.length) setErr("nenhum .gguf encontrado nessa pasta");
    } catch (e) {
      setErr(String(e));
    }
  };

  /** Abre o gerenciador de arquivos pra escolher a pasta dos modelos. */
  const pickDir = async () => {
    if (!inTauri()) return;
    try {
      const picked = await openDialog({
        directory: true,
        title: "Escolher a pasta dos modelos GGUF",
        defaultPath: dir || undefined,
      });
      if (typeof picked === "string" && picked) {
        setDir(picked);
        await scan(picked);
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  const start = async () => {
    if (!model) return;
    setErr("");
    setPhase("starting");
    try {
      localStorage.setItem(K.model, model);
      localStorage.setItem(K.ngl, ngl);
      localStorage.setItem(K.ctx, ctx);
      const p = await ai.startLlm(model, parseInt(ngl, 10) || 0, parseInt(ctx, 10) || 4096);
      setPort(p);
      setPhase("ready");
      setShowConfig(false);
    } catch (e) {
      setErr(String(e));
      setPhase("idle");
    }
  };

  const stop = async () => {
    abortRef.current?.abort();
    try {
      await ai.stopLlm();
    } catch {
      /* já parado */
    }
    setPhase("idle");
    setPort(0);
  };

  const send = async () => {
    const q = input.trim();
    if (!q || phase !== "ready" || !store.schema) return;
    const table = activeTable(store);
    if (!table) return;
    setInput("");
    const system = ai.DATA_SYSTEM(ai.schemaContext(store.schema), table.name, ai.rowsContext(table, store.rows));
    const history: ai.ChatMsg[] = [
      { role: "system", content: system },
      ...msgs.filter((m) => m.role !== "note").map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: q },
    ];
    setMsgs((cur) => [...cur, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setPhase("thinking");
    const ac = new AbortController();
    abortRef.current = ac;
    let acc = "";
    try {
      await ai.streamChat(
        port,
        history,
        (d) => {
          if (d.content) {
            acc += d.content;
            setMsgs((cur) => {
              const next = [...cur];
              next[next.length - 1] = { role: "assistant", content: acc };
              return next;
            });
          }
        },
        { signal: ac.signal }
      );
      // aplica operações, se houver
      const ops = ai.parseOps(acc);
      if (ops.length) {
        try {
          const res = await ai.applyOps(ops, store.schema, table);
          if (res.filters) await store.patchViewConfig({ filters: res.filters });
          if (res.schemaChanged) await store.refreshSchema();
          invalidateLinkLabels();
          await store.refreshRows();
          setMsgs((cur) => [...cur, { role: "note", content: "✓ " + res.applied.join("; ") }]);
        } catch (e) {
          setMsgs((cur) => [...cur, { role: "note", content: "⚠ operação rejeitada: " + (e instanceof Error ? e.message : e) }]);
          await store.refreshRows();
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) setErr(String(e));
    } finally {
      setPhase("ready");
    }
  };

  return (
    <aside className="ai-panel">
      <div className="ai-head">
        <strong>✦ IA local</strong>
        <span className={"ai-dot " + phase} title={phase} />
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="Configurar" onClick={() => setShowConfig(!showConfig)}>
          ⚙
        </button>
        <button className="icon-btn" onClick={onClose}>
          ×
        </button>
      </div>

      {showConfig && (
        <div className="ai-config">
          <label className="form-label">Pasta de modelos GGUF</label>
          <div className="pop-row">
            <input
              className="input input-sm"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void scan()}
              placeholder="C:\modelos"
            />
            <button className="btn btn-sm" title="Procurar pasta no gerenciador de arquivos" onClick={() => void pickDir()}>
              📁 Procurar…
            </button>
            <button className="btn btn-sm" title="Reescanear a pasta" onClick={() => void scan()}>
              ⟳
            </button>
          </div>
          {models.length > 0 && (
            <>
              <label className="form-label">Modelo</label>
              <select className="input input-sm" value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m.path} value={m.path}>
                    {m.name} ({m.size_gb.toFixed(1)} GB)
                  </option>
                ))}
              </select>
              <div className="pop-row">
                <label className="form-label">GPU layers</label>
                <input className="input input-sm w60" value={ngl} onChange={(e) => setNgl(e.target.value.replace(/\D/g, ""))} />
                <label className="form-label">Contexto</label>
                <input className="input input-sm w80" value={ctx} onChange={(e) => setCtx(e.target.value.replace(/\D/g, ""))} />
              </div>
            </>
          )}
          <div className="pop-row">
            {phase === "idle" || phase === "starting" ? (
              <button className="btn btn-sm primary" disabled={!model || phase === "starting"} onClick={() => void start()}>
                {phase === "starting" ? "Carregando modelo…" : "Iniciar IA"}
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => void stop()}>
                Parar IA
              </button>
            )}
            {port > 0 && <span className="muted">porta {port}</span>}
          </div>
        </div>
      )}

      {err && <div className="ai-err">{err}</div>}

      <div className="ai-body" ref={bodyRef}>
        {msgs.length === 0 && (
          <div className="ai-hello muted">
            Peça coisas como:
            <ul>
              <li>"cria uma tabela de clientes com os campos certos"</li>
              <li>"marca como Alta os registros atrasados"</li>
              <li>"filtra preço maior que 100"</li>
              <li>"quantos registros estão sem e-mail?"</li>
            </ul>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={"ai-msg " + m.role}>
            {m.content || (phase === "thinking" && i === msgs.length - 1 ? "…" : "")}
          </div>
        ))}
      </div>

      <div className="ai-input">
        <textarea
          className="input"
          rows={2}
          placeholder={phase === "ready" || phase === "thinking" ? "Fale com seus dados…" : "Inicie a IA acima"}
          value={input}
          disabled={phase !== "ready"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {phase === "thinking" ? (
          <button className="btn" onClick={() => abortRef.current?.abort()}>
            ◼
          </button>
        ) : (
          <button className="btn primary" disabled={phase !== "ready" || !input.trim()} onClick={() => void send()}>
            ➤
          </button>
        )}
      </div>
    </aside>
  );
}
