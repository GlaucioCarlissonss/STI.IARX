#!/usr/bin/env bash
#
# Constrói o agente para as três plataformas e empacota o que der para empacotar
# nesta máquina.
#
# ## O que sai daqui
#
#   dist/sti-agente-<versao>-<os>-<arch>[.exe]   os binários
#   dist/sti-agente_<versao>_amd64.deb           pacote Debian/Ubuntu
#   dist/sti-agente-<versao>-<os>-<arch>.tar.gz  tarball com o instalador
#   dist/SHA256SUMS                              para conferir o download
#
# ## O que NÃO sai
#
# O MSI. Ele precisa de WiX (candle + light) numa máquina Windows — e de um
# certificado para ser assinado, sem o qual o SmartScreen barra a instalação. O
# `wixl` do msitools roda em Linux, produz um .msi e **descarta as ações
# personalizadas em silêncio**: o instalador copiaria o executável sem criar
# tarefa nenhuma. Um instalador que parece certo e não faz o trabalho é pior que
# nenhum, então este script não finge que consegue.
#
# O caminho pronto para Windows é `empacotamento/windows/instalar.ps1`, que vai no
# tarball e roda num script de inicialização de GPO.
#
# ## A assinatura da autoatualização
#
# `CHAVE_PUBLICA` (base64 de uma chave pública Ed25519) é compilada no binário.
# Sem ela, o agente **recusa** se autoatualizar — fechado por padrão, nunca aberto
# por esquecimento. Gere o par com:
#
#   openssl genpkey -algorithm ed25519 -out agente-release.key
#   openssl pkey -in agente-release.key -pubout -outform DER | tail -c 32 | base64
#
# A chave PRIVADA nunca entra no repositório nem no servidor: ela assina a
# publicação, e é justamente por ficar fora do servidor que a assinatura protege
# contra um servidor comprometido.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSAO="${VERSAO:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
CHAVE_PUBLICA="${CHAVE_PUBLICA:-}"
DIST="dist"

PLATAFORMAS=(
  "linux/amd64"
  "linux/arm64"
  "windows/amd64"
  "darwin/amd64"
  "darwin/arm64"
)

echo "==> Agente $VERSAO"
if [[ -z "$CHAVE_PUBLICA" ]]; then
  echo "    sem CHAVE_PUBLICA: a autoatualização ficará desligada nestes binários"
fi

rm -rf "$DIST"
mkdir -p "$DIST"

LDFLAGS="-s -w -X github.com/iartech/sti-agente/internal/coleta.Versao=${VERSAO}"
if [[ -n "$CHAVE_PUBLICA" ]]; then
  LDFLAGS="$LDFLAGS -X github.com/iartech/sti-agente/internal/atualizacao.ChavePublica=${CHAVE_PUBLICA}"
fi

for alvo in "${PLATAFORMAS[@]}"; do
  os="${alvo%/*}"
  arch="${alvo#*/}"
  sufixo=""
  [[ "$os" == "windows" ]] && sufixo=".exe"

  saida="$DIST/sti-agente-${VERSAO}-${os}-${arch}${sufixo}"
  echo "==> $os/$arch"

  # CGO_ENABLED=0 é o que garante o binário único sem dependência de libc: ele
  # roda em Alpine, em contêiner distroless e em RHEL antigo, sem recompilar.
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$saida" ./cmd/sti-agente
done

# ---------------------------------------------------------------------------
# Tarballs: o binário mais o que é preciso para instalar
# ---------------------------------------------------------------------------
for alvo in "${PLATAFORMAS[@]}"; do
  os="${alvo%/*}"
  arch="${alvo#*/}"
  sufixo=""
  [[ "$os" == "windows" ]] && sufixo=".exe"

  tmp="$(mktemp -d)"
  cp "$DIST/sti-agente-${VERSAO}-${os}-${arch}${sufixo}" "$tmp/sti-agente${sufixo}"
  cp README.md "$tmp/"

  case "$os" in
    linux)   cp empacotamento/linux/sti-agente.service "$tmp/" ;;
    darwin)  cp empacotamento/macos/*.plist "$tmp/" ;;
    windows) cp empacotamento/windows/instalar.ps1 empacotamento/windows/desinstalar.ps1 "$tmp/" ;;
  esac

  tar -czf "$DIST/sti-agente-${VERSAO}-${os}-${arch}.tar.gz" -C "$tmp" .
  rm -rf "$tmp"
done

# ---------------------------------------------------------------------------
# Pacote Debian/Ubuntu
# ---------------------------------------------------------------------------
if command -v dpkg-deb >/dev/null 2>&1; then
  echo "==> .deb"
  # A versão do Debian não aceita o `-dirty` nem o hash curto do `git describe`.
  # Sem esta limpeza, `dpkg-deb` recusa o pacote com uma mensagem sobre caractere
  # inválido que não diz qual.
  VERSAO_DEB="$(echo "$VERSAO" | sed 's/^v//; s/-/~/g; s/[^0-9A-Za-z.~+]//g')"
  [[ -z "$VERSAO_DEB" ]] && VERSAO_DEB="0.0.0"

  raiz="$(mktemp -d)"
  # `mktemp -d` cria com 0700, e o diretório raiz do pacote vira `/` na
  # instalação: sem este chmod, `dpkg -i` troca a permissão da RAIZ do sistema de
  # arquivos para 0700 e derruba a máquina. Foi encontrado inspecionando
  # `dpkg-deb --contents` — a primeira versão deste script tinha o defeito, e ele
  # não aparece em teste nenhum que não olhe o conteúdo do pacote.
  chmod 0755 "$raiz"
  mkdir -p "$raiz/DEBIAN" "$raiz/usr/local/bin" "$raiz/lib/systemd/system" "$raiz/var/lib/sti-agente"
  install -m 0755 "$DIST/sti-agente-${VERSAO}-linux-amd64" "$raiz/usr/local/bin/sti-agente"
  install -m 0644 empacotamento/linux/sti-agente.service "$raiz/lib/systemd/system/sti-agente.service"
  chmod 0700 "$raiz/var/lib/sti-agente"

  cat > "$raiz/DEBIAN/control" <<CONTROL
Package: sti-agente
Version: ${VERSAO_DEB}
Section: admin
Priority: optional
Architecture: amd64
Maintainer: IAR Technology <solucoes@iaroffice.com.br>
Description: Agente de inventario do STI
 Coleta inventario de hardware e software e envia ao STI.
 Nao captura tela, arquivo nem navegacao.
CONTROL

  # O postinst NÃO habilita o serviço: sem `agente.json` ele subiria, falharia e
  # entraria no laço de reinício do systemd. Quem instala precisa configurar
  # primeiro, e a mensagem diz exatamente como.
  cat > "$raiz/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
if [ ! -f /var/lib/sti-agente/agente.json ]; then
  echo ""
  echo "O agente foi instalado mas ainda NAO esta configurado."
  echo ""
  echo "  sudo sti-agente-configurar https://seu-servidor inv_token_do_lote"
  echo ""
  echo "ou grave /var/lib/sti-agente/agente.json a mao e rode:"
  echo "  sudo systemctl enable --now sti-agente"
  echo ""
else
  systemctl daemon-reload || true
  systemctl enable --now sti-agente || true
fi
POSTINST
  chmod 0755 "$raiz/DEBIAN/postinst"

  cat > "$raiz/DEBIAN/prerm" <<'PRERM'
#!/bin/sh
set -e
systemctl disable --now sti-agente 2>/dev/null || true
PRERM
  chmod 0755 "$raiz/DEBIAN/prerm"

  # O ajudante de configuração. Ele existe porque "grave este JSON à mão" é o
  # passo onde a implantação em Linux para: uma aspa errada e o agente não sobe.
  mkdir -p "$raiz/usr/local/bin"
  cat > "$raiz/usr/local/bin/sti-agente-configurar" <<'CONFIGURAR'
#!/bin/sh
# Grava a configuração do agente e sobe o serviço.
#   sti-agente-configurar https://sti.exemplo.com inv_token_do_lote
set -eu

if [ "$#" -lt 2 ]; then
  echo "uso: sti-agente-configurar <https://servidor> <token-de-inscricao>" >&2
  exit 2
fi

SERVIDOR="$1"
TOKEN="$2"

case "$SERVIDOR" in
  https://*) ;;
  # O token de inscrição viaja nesta URL. Em http ele viaja em claro.
  *) echo "erro: o servidor precisa comecar com https://" >&2; exit 2 ;;
esac

mkdir -p /var/lib/sti-agente
chmod 0700 /var/lib/sti-agente

# `printf` com %s e sem interpolação no formato: um token com barra invertida
# viraria escape dentro do JSON e quebraria o arquivo.
printf '{"servidor":"%s","token_inscricao":"%s","intervalo_coleta_min":1440,"intervalo_envio_min":10,"auto_atualizar":false}\n' \
  "${SERVIDOR%/}" "$TOKEN" > /var/lib/sti-agente/agente.json
chmod 0600 /var/lib/sti-agente/agente.json

# Sem systemd não há serviço a subir — acontece em contêiner, e contêiner às
# vezes também é inventariado. A configuração já foi gravada, então isto é um
# aviso e não uma falha: `--uma-vez` num cron resolve o caso, e dizer isso aqui
# evita que alguém conclua que a instalação não funcionou.
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl daemon-reload 2>/dev/null; then
  echo ""
  echo "Configuracao gravada, mas nao ha systemd nesta maquina."
  echo "Rode a coleta por conta propria, por exemplo num cron:"
  echo "  */10 * * * * /usr/local/bin/sti-agente --batimento"
  echo "  0 3 * * *    /usr/local/bin/sti-agente --uma-vez"
  echo ""
  echo "Diagnostico:  sti-agente --diagnostico"
  exit 0
fi

systemctl enable --now sti-agente

echo "Agente configurado. Diagnostico:  sti-agente --diagnostico"
CONFIGURAR
  chmod 0755 "$raiz/usr/local/bin/sti-agente-configurar"

  dpkg-deb --build --root-owner-group "$raiz" \
    "$DIST/sti-agente_${VERSAO_DEB}_amd64.deb" >/dev/null
  rm -rf "$raiz"

  # Confere o que foi empacotado de verdade, em vez de confiar no que o script
  # pretendia. Um pacote que troca a permissão de `/` instala sem erro e derruba a
  # máquina depois — não há como descobrir isso tarde e barato.
  conteudo="$(dpkg-deb --contents "$DIST/sti-agente_${VERSAO_DEB}_amd64.deb")"
  if ! echo "$conteudo" | grep -qE '^drwxr-xr-x [^ ]+ +0 .* \./$'; then
    echo "ERRO: o diretório raiz do .deb não está 0755 — instalar trocaria a permissão de /" >&2
    echo "$conteudo" | head -3 >&2
    exit 1
  fi
  if ! echo "$conteudo" | grep -q 'drwx------ .*/var/lib/sti-agente/$'; then
    echo "ERRO: /var/lib/sti-agente deveria estar 0700 — ele guarda o token da máquina" >&2
    exit 1
  fi
else
  echo "==> dpkg-deb ausente: pulando o .deb"
fi

# ---------------------------------------------------------------------------
# Somas, para conferir o download
# ---------------------------------------------------------------------------
( cd "$DIST" && sha256sum ./* > SHA256SUMS )

echo ""
echo "==> Pronto:"
ls -1sh "$DIST"
echo ""
if [[ -n "$CHAVE_PUBLICA" ]]; then
  echo "Para publicar a autoatualização, assine o binário do alvo:"
  echo "  openssl pkeyutl -sign -rawin -inkey agente-release.key \\"
  echo "    -in $DIST/sti-agente-${VERSAO}-windows-amd64.exe | base64 -w0"
  echo "e ponha o resultado em AGENT_RELEASE_SIGNATURE."
fi
