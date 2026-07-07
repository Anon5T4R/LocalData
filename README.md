# LocalData

Banco de dados visual **100% offline** — um Airtable/Access local, com **IA local**.
Multiusuário na rede da empresa, extensível e sem nuvem.
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
- **Tipos de campo plugáveis (extensões)** — um arquivo `.js` na pasta de extensões
  registra tipos novos (validação, máscara, cor). Ver [Extensões](#extensões).
- **Backup automático ao abrir** — cópia da base antes de cada abertura, com
  retenção configurável (10/50/N por base; 0 desliga). Ver [Backups](#backups).
- **Modo servidor multiusuário (LAN)** — hospede a base pra equipe pela rede
  local, com usuários, senhas e papéis (leitor/editor/admin) + permissão por
  tabela. Ver [Multiusuário](#multiusuário).
- **Auditoria** — trilha de quem mudou o quê e quando (por registro e geral).
- **Integridade e validação** — relação com "impedir exclusão"/"desvincular";
  campos únicos, obrigatórios, regex, mín/máx.
- **Import com upsert** — reimporte uma planilha e atualize os registros por um
  campo-chave, criando só os novos.
- **Automações** — "quando X → notifique / defina campo".
- **Relatórios imprimíveis** — exporte a view atual pra PDF (impressora do SO).
- **Escala** — consultas e agregações no SQL; ~100k registros por tabela com folga.
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

## Extensões

Tipos de campo plugáveis, pensados pra dev de empresa que precisa de um tipo
específico (CPF, CNPJ, placa, SKU…). Sem loja, sem sandbox: é código local seu,
rodando na sua máquina.

- **Onde:** menu 🧩 na barra superior → "Abrir pasta de extensões" (fica no
  diretório de configuração do app). Todo `.js` da pasta é carregado ao abrir o
  app (ou no "Recarregar extensões").
- **Como:** o arquivo roda com a API global `localdata`. O exemplo
  `exemplo-cpf.js` (instalado automaticamente na primeira execução) documenta
  tudo:

```js
localdata.registerFieldType({
  id: "cpf",                // único — fica gravado no campo
  name: "CPF",              // nome no seletor de tipo (grupo "Extensões")
  icon: "🪪",               // opcional
  description: "…",         // opcional (dica no editor de campo)
  placeholder: "…",         // opcional
  multiline: false,         // opcional (editor vira textarea)
  parse(texto) { /* normaliza; throw new Error(...) rejeita */ },
  format(valor) { /* texto exibido na célula */ },
  color(valor) { /* cor CSS do texto, ou undefined */ },
});
```

- **Robustez:** no banco, campo de extensão é **sempre TEXT** numa coluna real —
  busca, ordenação e filtros funcionam como texto e **nada da camada SQL depende
  do código da extensão**. Remover a extensão não perde dados: as células voltam
  a aparecer como texto simples.

## Backups

Ao abrir uma base, o app copia o arquivo pra pasta central de backups
(`<config do app>/backups`) antes de tocar nele, e mantém as N cópias mais
recentes **por base** (configurável na tela inicial: desligado/10/50/número
livre). Restaurar = copiar o `.tbase` do backup de volta. A pasta abre pelo
botão "📂 Backups" na tela inicial.

## Multiusuário

Pensado pra time de empresa média, sem nuvem: a base continua um arquivo local
numa máquina, que passa a **servir** os dados pra rede.

- **Servir (host):** abra a base, menu 🌐 → aba *Usuários* cadastre ao menos um
  **admin** (usuário + senha, guardados na própria base com Argon2) → aba
  *Servir* → escolha a porta e clique em *Começar a servir*. O app mostra o
  endereço (ex.: `http://192.168.0.10:8787`). Mantenha o LocalData aberto.
- **Conectar (cliente):** na tela inicial, *🌐 Conectar a um servidor*, informe
  o endereço, usuário e senha. As edições aparecem pra todos em ~2s (polling).
- **Papéis:** *leitor* (só vê) < *editor* (edita registros) < *admin* (estrutura
  + usuários). Dá pra sobrepor por tabela: sem acesso / só leitura / edição.
- **Como funciona:** um servidor HTTP local (tiny_http) atende os mesmos comandos
  do app, tudo serializado no mesmo SQLite — **nunca há escrita concorrente no
  arquivo**. O servidor injeta o autor em cada mudança (a auditoria não mente).

> Escopo: rede local, um arquivo, um processo servidor. Não é um SaaS — é o seu
> Access/Airtable rodando na máquina da sala ao lado.

## Formato do arquivo

Um `.tbase` contém:

- `_taylor_tables` / `_taylor_fields` / `_taylor_views` — o schema "rico"
  (tipos de campo, opções, configuração das views);
- `_taylor_blobs` — anexos;
- uma tabela SQL real `t_<id>` por tabela do usuário, com uma coluna `c_<id>` por
  campo (nomes de exibição ficam nos metadados; IDs estáveis = renomear nunca gera DDL).

## Licença

[MIT](LICENSE)
