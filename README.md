# LocalData

Banco de dados visual **100% offline** — um Airtable/Access local, com **IA local**.
Parte da suíte Taylor (LocalOffice, LocalSheets, LocalSlides, LocalCode, TaylorHub).

## O que ele faz

- **Bases em arquivo único (`.tbase`)** — é um SQLite comum e legítimo: abre em
  qualquer ferramenta SQLite. Seus dados são seus; nada de nuvem, conta ou telemetria.
- **Tabelas tipadas**: texto, texto longo, número (decimal/inteiro/moeda/percentual),
  checkbox, data, seleção única, seleção múltipla, **avaliação (estrelas)**, URL,
  e-mail, telefone, **relação entre tabelas**, **anexo** (guardado dentro do arquivo),
  **fórmula** (`{Preço} * {Qtd}`, `IF(...)`, `DAYS(...)`, etc.) e **lookup/rollup**
  (valores e agregações — soma, média, contagem… — através das relações).
- **Views por tabela**, persistidas na base:
  - **Grade** — virtualizada, edição inline por tipo, **agrupamento colapsável**,
    **seleção retangular + copiar/colar TSV** (Excel/Sheets), **rodapé de agregação**
    por coluna, cor de linha por seleção, coluna primária fixa,
    redimensionar/ocultar/duplicar colunas
  - **Kanban** — agrupa por seleção única, arrastar cartões muda o registro
  - **Calendário** — mês a mês por campo de data
  - **Galeria** — cartões com capa de anexo
  - **Formulário** — entrada de dados registro a registro
- **Filtros, ordenação e busca** persistidos por view — sempre em SQL parametrizado.
- **Duplicar** tabela (com dados), campo e view; desfazer/refazer de registros.
- **Import CSV/XLSX** com inferência de tipos (número, data, checkbox, select) e
  **export XLSX/CSV**.
- **IA local (llama.cpp / GGUF)**: "cria uma tabela de clientes com os campos certos",
  "categoriza estes registros", "filtra os atrasados". O modelo devolve um JSON de
  operações que é **validado contra o schema** e traduzido em comandos parametrizados —
  **nunca SQL cru do modelo**. Roda em `127.0.0.1` (porta 8101+), sem internet.

## Stack

Tauri 2 + React 19 + Vite + TypeScript; Rust + rusqlite (SQLite embutido);
llama.cpp (`llama-server`) como sidecar de IA (Vulkan com fallback CPU).

## Rodando em desenvolvimento

```bash
npm install
# opcional (IA): baixa o llama-server para src-tauri/binaries/llama
powershell -ExecutionPolicy Bypass -File scripts/fetch-llama.ps1   # Windows
bash scripts/fetch-llama.sh                                        # Linux
npm run tauri dev
```

Testes: `npm test` (frontend) e `cargo test` em `src-tauri/` (backend).

## Formato do arquivo

Um `.tbase` contém:

- `_taylor_tables` / `_taylor_fields` / `_taylor_views` — o schema "rico"
  (tipos de campo, opções, configuração das views);
- `_taylor_blobs` — anexos;
- uma tabela SQL real `t_<id>` por tabela do usuário, com uma coluna `c_<id>` por
  campo (nomes de exibição ficam nos metadados; IDs estáveis = renomear nunca gera DDL).

## Licença

[MIT](LICENSE)
