import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getStartupFile, inTauri } from "./lib/backend";
import { activeView, useStore } from "./state/store";
import { StartScreen } from "./components/StartScreen";
import { TopBar } from "./components/TopBar";
import { ViewSidebar } from "./components/ViewSidebar";
import { Toolbar } from "./components/Toolbar";
import { GridView } from "./components/GridView";
import { KanbanView } from "./components/KanbanView";
import { CalendarView } from "./components/CalendarView";
import { GalleryView } from "./components/GalleryView";
import { FormView } from "./components/FormView";
import { RecordModal } from "./components/RecordModal";
import { AiPanel } from "./components/AiPanel";
import { useExtensions } from "./lib/extensions";
import { isRemote } from "./lib/remote";
import { t as tr } from "./lib/i18n";
import "./App.css";

const THEME_KEY = "localdata.theme";

export default function App() {
  const store = useStore();
  const [theme, setTheme] = useState(localStorage.getItem(THEME_KEY) ?? "light");
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // extensões (tipos de campo plugáveis): carrega uma vez na inicialização
  useEffect(() => {
    void useExtensions.getState().reload();
  }, []);

  // polling de mudanças quando conectado a um servidor remoto (multiusuário):
  // vê edições de colegas em ~2s sem recarregar a mão.
  useEffect(() => {
    if (!store.schema || !isRemote()) return;
    const t = setInterval(() => void useStore.getState().poll(), 2000);
    return () => clearInterval(t);
  }, [store.schema]);

  // undo/redo globais (Ctrl+Z / Ctrl+Y ou Ctrl+Shift+Z) — fora de inputs
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        void useStore.getState().undo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        void useStore.getState().redo();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // arquivo passado na abertura ("abrir com") + segunda instância
  useEffect(() => {
    if (!inTauri()) return;
    void getStartupFile().then((f) => {
      if (f) void store.openBase(f);
    });
    const un = listen<string>("open-file", (e) => {
      if (e.payload) void store.openBase(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = activeView(store);

  return (
    <div className="app">
      {!store.schema ? (
        <StartScreen />
      ) : (
        <>
          <TopBar theme={theme} onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")} />
          <div className="workspace">
            <ViewSidebar />
            <main className="main">
              <Toolbar onToggleAi={() => setAiOpen(!aiOpen)} />
              {view?.kind === "grid" && <GridView />}
              {view?.kind === "kanban" && <KanbanView />}
              {view?.kind === "calendar" && <CalendarView />}
              {view?.kind === "gallery" && <GalleryView />}
              {view?.kind === "form" && <FormView />}
            </main>
            {aiOpen && <AiPanel onClose={() => setAiOpen(false)} />}
          </div>
          <RecordModal />
        </>
      )}
      {store.error && (
        <div className="error-banner" onClick={() => store.setError(null)}>
          ⚠ {store.error} <span className="muted">{tr("app.clickToClose")}</span>
        </div>
      )}
    </div>
  );
}
