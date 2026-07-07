#!/usr/bin/env bash
# Baixa o llama.cpp (Linux x64, Vulkan com fallback CPU) e instala em binaries/llama.
# IMPORTANTE: os assets Linux do llama.cpp são .tar.gz (NÃO .zip) — por isso o
# AppImage não precisa de nenhuma ferramenta de zip. Só o Windows usa .zip
# (scripts/fetch-llama.ps1).
#
# Robustez: usa o token do CI (GH_TOKEN) p/ evitar rate-limit; extrai SÓ URLs
# reais de download (nunca a URL da API); tenta de novo se os assets ainda não
# subiram (o llama.cpp publica a release e sobe os binários aos poucos); e valida
# que o download é gzip antes de extrair.
# Uso: bash scripts/fetch-llama.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LLAMA_DIR="$ROOT/src-tauri/binaries/llama"
mkdir -p "$LLAMA_DIR"

if [ -f "$LLAMA_DIR/llama-server" ]; then
  echo "llama runtime já existe em $LLAMA_DIR"
  exit 0
fi

AUTH=()
[ -n "${GH_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GH_TOKEN")
API_URL="https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"

# Extrai uma URL de download de asset (github.com/.../*.tar.gz), nunca a URL da API.
find_url() {
  local json="$1" u
  u=$(printf '%s' "$json" | grep -oE 'https://github\.com/[^"]*ubuntu-vulkan-x64\.tar\.gz' | head -1 || true)
  [ -z "$u" ] && u=$(printf '%s' "$json" | grep -oE 'https://github\.com/[^"]*ubuntu-x64\.tar\.gz' | head -1 || true)
  printf '%s' "$u"
}

URL=""
for attempt in 1 2 3 4 5; do
  echo "Buscando release mais recente do llama.cpp (tentativa $attempt)..."
  API=$(curl -fsSL --retry 3 --retry-delay 2 -H "User-Agent: localdata-app" "${AUTH[@]}" "$API_URL" || true)
  URL=$(find_url "$API")
  [ -n "$URL" ] && break
  echo "asset Linux ainda não disponível nesta release; aguardando 15s..."
  sleep 15
done
[ -z "$URL" ] && { echo "asset ubuntu(-vulkan)-x64.tar.gz não encontrado"; exit 1; }

echo "Baixando $URL"
curl -fsSL --retry 3 --retry-delay 2 "$URL" -o /tmp/llama.tar.gz
if ! gzip -t /tmp/llama.tar.gz 2>/dev/null; then
  echo "arquivo baixado não é um .tar.gz válido (URL: $URL)"; exit 1
fi

rm -rf /tmp/llama-extract
mkdir -p /tmp/llama-extract
tar -xzf /tmp/llama.tar.gz -C /tmp/llama-extract
SRV=$(find /tmp/llama-extract -type f -name 'llama-server' | head -1)
[ -z "$SRV" ] && { echo "llama-server não encontrado no arquivo"; exit 1; }
cp -r "$(dirname "$SRV")"/* "$LLAMA_DIR"/
chmod +x "$LLAMA_DIR/llama-server" || true
rm -rf /tmp/llama.tar.gz /tmp/llama-extract
echo "Instalado em $LLAMA_DIR"
