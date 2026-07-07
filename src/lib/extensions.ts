// Extensões do LocalData: tipos de campo plugáveis.
//
// Uma extensão é um arquivo .js na pasta de extensões do app (config dir),
// avaliado no webview na inicialização com acesso à API `localdata`.
// SEM sandbox de propósito: quem escreve extensão é o próprio usuário (dev),
// não existe loja — é código local rodando na máquina local.
//
// A camada SQL não sabe que extensões existem: todo campo custom é TEXT com
// coluna real, validado no Rust como texto. `parse`/`format`/`color` só
// moldam o que entra e o que aparece — a robustez do banco não depende disso.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./backend";
import { EXAMPLE_EXTENSION_FILE, EXAMPLE_EXTENSION_SOURCE } from "./exampleExtension";

export interface ExtFieldType {
  /** id único; fica gravado no campo (options.extType) */
  id: string;
  /** nome exibido no seletor de tipo */
  name: string;
  icon?: string;
  description?: string;
  placeholder?: string;
  /** editor vira textarea */
  multiline?: boolean;
  /** normaliza/valida no commit; lançar Error rejeita a edição */
  parse?: (text: string) => string;
  /** texto exibido na célula (o valor cru fica no banco) */
  format?: (value: string) => string;
  /** cor CSS do texto da célula */
  color?: (value: string) => string | undefined;
  /** arquivo de origem (preenchido pelo loader) */
  file?: string;
}

export interface ExtError {
  file: string;
  message: string;
}

// registry síncrono (células e clipboard leem sem hook)
const registry = new Map<string, ExtFieldType>();

export function extTypeSpec(id: string | undefined): ExtFieldType | undefined {
  return id ? registry.get(id) : undefined;
}

interface ExtState {
  types: ExtFieldType[];
  errors: ExtError[];
  loaded: boolean;
  reload(): Promise<void>;
}

function evalExtension(file: string, source: string, errors: ExtError[]) {
  const api = {
    version: "0.4.0",
    registerFieldType(spec: unknown) {
      const s = spec as Partial<ExtFieldType>;
      if (!s || typeof s.id !== "string" || !s.id.trim() || typeof s.name !== "string" || !s.name.trim()) {
        throw new Error("registerFieldType precisa de 'id' e 'name' (strings)");
      }
      if (registry.has(s.id)) {
        errors.push({ file, message: `tipo "${s.id}" já registrado por ${registry.get(s.id)?.file} — mantido o primeiro` });
        return;
      }
      registry.set(s.id, { ...(s as ExtFieldType), file });
    },
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("localdata", source)(api);
  } catch (e) {
    errors.push({ file, message: e instanceof Error ? e.message : String(e) });
  }
}

export const useExtensions = create<ExtState>((set) => ({
  types: [],
  errors: [],
  loaded: false,

  async reload() {
    if (!inTauri()) {
      set({ types: [], errors: [], loaded: true });
      return;
    }
    // instala o exemplo na 1ª execução (nunca sobrescreve edições do usuário)
    try {
      await invoke<boolean>("extensions_install_default", {
        file: EXAMPLE_EXTENSION_FILE,
        source: EXAMPLE_EXTENSION_SOURCE,
      });
    } catch {
      /* melhor esforço */
    }
    const errors: ExtError[] = [];
    registry.clear();
    try {
      const files = await invoke<{ file: string; source: string }[]>("extensions_list");
      for (const f of files) evalExtension(f.file, f.source, errors);
    } catch (e) {
      errors.push({ file: "(pasta de extensões)", message: e instanceof Error ? e.message : String(e) });
    }
    set({ types: Array.from(registry.values()), errors, loaded: true });
  },
}));

export const extensionsDir = () => invoke<string>("extensions_dir");
export const backupsDir = () => invoke<string>("backups_dir");
