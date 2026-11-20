#!/usr/bin/env bash
# =============================================================================
# A varredura inteira, numa ordem que não mente.
#
# POR QUE ESTE ARQUIVO EXISTE
# ---------------------------
# Até agora as 23 suítes de navegador eram rodadas por um laço digitado na hora,
# e foi assim que dois defeitos de MEDIÇÃO entraram num relatório — os dois na
# mesma varredura, os dois nomeados em `docs/padroes-de-engenharia.md`:
#
#  1. O laço decidia "passou" procurando a frase `TODAS AS ASSERÇÕES PASSARAM`.
#     `telas.spec.mjs` não imprime essa frase — ela termina com `0 rota(s) com
#     problema de 49`. A suíte estava verde e foi relatada como VERMELHA.
#
#     Pior que o falso vermelho: uma suíte que MORRESSE antes da primeira
#     asserção seria relatada do mesmo jeito, sem distinção. Contar pela frase
#     de sucesso confunde "falhou", "morreu" e "não usa essa frase".
#
#  2. Rodei `npm run build` com o servidor de pé servindo a varredura,
#     reescrevendo `.next` debaixo dele. As últimas telas tomaram 500 por minha
#     causa, não por defeito do produto — e eu quase relatei isso como regressão.
#
# O conserto não é tomar mais cuidado. É este arquivo.
#
# AS REGRAS QUE ELE APLICA
# ------------------------
#  · Constrói UMA vez, antes da primeira suíte, e ABORTA se a construção falhar.
#    Medir o pacote da construção anterior dá verde em correção que não está lá.
#  · NUNCA remonta no meio da varredura — as primeiras suítes mediriam o build
#    velho e as últimas o novo, e o resultado não descreveria nenhum dos dois.
#  · Decide o desfecho pelo CÓDIGO DE SAÍDA, nunca por frase na saída.
#  · Decide "morreu" pelo rodapé que o Node imprime ao estourar sem captura, e
#    distingue morte de falha no relatório. Uma morte não diz o que estava
#    errado, e chamá-la de falha esconde que não houve medição nenhuma.
#  · Recusa começar com a porta ocupada: um servidor de outra sessão serviria um
#    build que não é o que acabou de ser construído.
#
# USO
#   bash scripts/verificar.sh            # tudo
#   bash scripts/verificar.sh --rapido   # sem as suítes de navegador autenticadas
#   bash scripts/verificar.sh --duas     # as de navegador duas vezes (idempotência)
# =============================================================================
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

PORTA="${PORTA:-3177}"
RAPIDO=0
DUAS=1
for arg in "$@"; do
  case "$arg" in
    --rapido) RAPIDO=1 ;;
    --duas)   DUAS=2 ;;
    *) echo "argumento desconhecido: $arg"; exit 2 ;;
  esac
done

TMP="$(mktemp -d)"

# Onde fica a saída de quem reprovou. O `$TMP` some no `trap`, e com ele o
# único registro do que aconteceu — "FALHOU" sem log obriga a rodar os
# quarenta minutos de novo só para reler a mesma linha.
GUARDA="$RAIZ/.verificacao"
rm -rf "$GUARDA"; mkdir -p "$GUARDA"
trap 'rm -rf "$TMP"; fuser -k "${PORTA:-3177}/tcp" >/dev/null 2>&1' EXIT

falhas=0
mortes=0
linhas=()

marcar() { # nome resultado detalhe
  local linha; linha="$(printf '%-28s %-10s %s' "$1" "$2" "${3:-}")"
  linhas+=("$linha")
  # Impresso NA HORA, e não só no resumo: uma varredura que fica quarenta
  # minutos muda é difícil de confiar e impossível de depurar — não dá para
  # saber se ela está trabalhando, em qual suíte está, nem se já falhou.
  printf '  %s\n' "$linha"
}

# A porta REALMENTE livre, e não "mandei matar".
#
# `npx next start` é um invólucro: ele cria um filho que é quem abre o socket.
# Matar o `$!` derruba o invólucro e deixa o filho com a porta — foi assim que
# `aplicacao.spec.mjs` reprovou numa varredura completa, recusando-se a subir
# o próprio servidor, e o relatório não disse por quê.
#
# Mata por PORTA, e depois ESPERA a porta cair de verdade: `kill` é um pedido,
# não um fato, e seguir adiante sem conferir é medir o resultado do servidor
# anterior.
liberar_porta() {
  fuser -k "$PORTA/tcp" > /dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    if ! (exec 3<>/dev/tcp/127.0.0.1/"$PORTA") 2>/dev/null; then return 0; fi
    exec 3<&- 2>/dev/null
    sleep 1
  done
  return 1
}

titulo() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# -----------------------------------------------------------------------------
titulo '1. Estático — tipos, lint e testes unitários'
# -----------------------------------------------------------------------------
# Primeiro porque é o mais barato e o que falha mais cedo. Uma varredura de
# navegador que roda sobre código que nem compila gasta vinte minutos para
# dizer o que o `tsc` diria em dez segundos.

if npm run typecheck > "$TMP/tsc.log" 2>&1; then
  marcar 'tsc' 'ok'
else
  marcar 'tsc' 'FALHOU' "$(tail -3 "$TMP/tsc.log" | head -1)"
  falhas=$((falhas+1))
fi

if npm run lint > "$TMP/lint.log" 2>&1; then
  marcar 'eslint' 'ok' "$(grep -oE '[0-9]+ problems?.*' "$TMP/lint.log" | tail -1)"
else
  marcar 'eslint' 'FALHOU' "$(grep -E '✖' "$TMP/lint.log" | tail -1)"
  falhas=$((falhas+1))
fi

if npm test > "$TMP/vitest.log" 2>&1; then
  marcar 'vitest' 'ok' "$(grep -oE 'Tests  [0-9]+ passed.*' "$TMP/vitest.log" | tail -1)"
else
  marcar 'vitest' 'FALHOU' "$(grep -oE 'Tests .*' "$TMP/vitest.log" | tail -1)"
  falhas=$((falhas+1))
fi

# -----------------------------------------------------------------------------
titulo '2. Banco — migrações do zero e asserções de RLS'
# -----------------------------------------------------------------------------
if PGPASSWORD="${PGPASSWORD:-postgres}" npm run db:validate > "$TMP/db.log" 2>&1; then
  n=$(grep -c 'NOTICE:    ok' "$TMP/db.log" || true)
  marcar 'db:validate' 'ok' "$n asserções"
else
  marcar 'db:validate' 'FALHOU' "$(grep -E 'ERRO|ERROR|FALHOU' "$TMP/db.log" | head -1)"
  falhas=$((falhas+1))
fi

# A conferência dos números que a documentação afirma. Ela sai com 1 quando
# diverge, e é de propósito: número escrito à mão envelhece em silêncio.
if PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGPASSWORD="${PGPASSWORD:-postgres}" \
     python3 scripts/conferir-numeros.py > "$TMP/numeros.log" 2>&1; then
  marcar 'conferir-numeros' 'ok'
else
  marcar 'conferir-numeros' 'FALHOU' "$(grep -E 'ERRADO' "$TMP/numeros.log" | head -1)"
  falhas=$((falhas+1))
fi

# -----------------------------------------------------------------------------
titulo '3. O artefato navegável'
# -----------------------------------------------------------------------------
# Não dependem de servidor: abrem `file://`. Rodam antes do build por isso.
rodar_suite() { # caminho rótulo
  local caminho="$1" rotulo="$2" saida codigo
  saida="$TMP/$(basename "$caminho").log"
  node "$caminho" > "$saida" 2>&1
  codigo=$?

  # "Morreu" se decide pelo rodapé do Node, NUNCA procurando a palavra "Error"
  # na saída: uma suíte pode imprimir "Error" num caso de teste legítimo, e uma
  # que estoura sem captura pode não imprimir nada parecido.
  if grep -qE '^Node\.js v[0-9]' "$saida"; then
    cp "$saida" "$GUARDA/$(basename "$caminho" .spec.mjs).log"
    marcar "$rotulo" 'MORREU' "$(grep -E '^[A-Za-z]*Error' "$saida" | head -1 | cut -c1-70)"
    # A MORTE É O CASO EM QUE O LOG MAIS IMPORTA, e era o único que não o
    # guardava: o `return` saía antes do `cp` do ramo de falha. Uma suíte que
    # morre não diz o que estava errado, então a saída dela é tudo o que
    # sobra — e sem ela a investigação recomeça com uma varredura inteira.
    sed -n '/^[A-Za-z]*Error\|^\s*at /p' "$saida" | head -3 | sed 's/^/        /'
    mortes=$((mortes+1)); falhas=$((falhas+1))
    return
  fi

  local n; n=$(grep -cE '^\s*ok ' "$saida" || true)
  if [ "$codigo" -eq 0 ]; then
    marcar "$rotulo" 'ok' "$n asserções"
  else
    cp "$saida" "$GUARDA/$(basename "$caminho" .spec.mjs).log"
    marcar "$rotulo" 'FALHOU' "$(grep -E 'FALHOU' "$saida" | head -1 | cut -c1-60)"
    # A falha costuma vir precedida do diagnóstico que a própria suíte imprime
    # — a lista que a paleta devolveu, a rota que deu 500. Mostrá-lo aqui evita
    # que a pessoa tenha de ir atrás do arquivo para saber se vale a pena.
    grep -B 2 -E 'FALHOU' "$saida" | grep -vE 'FALHOU|^--' | tail -1 \
      | sed 's/^/        /' | grep -v '^\s*$' || true
    falhas=$((falhas+1))
  fi
}

rodar_suite demo/tests/prototipo.spec.mjs 'prototipo'

# -----------------------------------------------------------------------------
titulo '4. Construir — uma vez, e aborta se falhar'
# -----------------------------------------------------------------------------
if [ "$RAPIDO" -eq 1 ]; then
  marcar 'build' 'pulado' '--rapido'
else
  # A porta ocupada é recusa, não aviso: um servidor de outra sessão serviria um
  # build que não é este, e a varredura mediria outra coisa sem dizer.
  if (exec 3<>/dev/tcp/127.0.0.1/"$PORTA") 2>/dev/null; then
    exec 3<&- 2>/dev/null
    echo "  a porta $PORTA já está ocupada."
    echo "  Encerre o servidor antes: fuser -k $PORTA/tcp"
    marcar 'build' 'ABORTOU' "porta $PORTA ocupada"
    falhas=$((falhas+1))
    RAPIDO=1
  elif npm run build > "$TMP/build.log" 2>&1; then
    marcar 'build' 'ok' "$(grep -oE 'Compiled successfully.*' "$TMP/build.log" | tail -1)"
  else
    # Abortar, e não seguir: medir o pacote anterior é pior do que não medir.
    echo
    tail -20 "$TMP/build.log"
    marcar 'build' 'ABORTOU' 'a construção falhou — nada abaixo foi medido'
    falhas=$((falhas+1))
    RAPIDO=1
  fi
fi

# -----------------------------------------------------------------------------
if [ "$RAPIDO" -eq 0 ]; then
titulo '5. Navegador, contra o build que acabou de sair'
# -----------------------------------------------------------------------------
  # Produção, nunca `next dev`: num ambiente onde o WebSocket de recarga a quente
  # não conecta, o React não hidrata, e o sintoma é um conjunto de asserções
  # falhando de um jeito convincente. Ver o README.
  set -a; . ./.env.local 2>/dev/null || true; set +a
  NEXT_PUBLIC_SITE_URL="http://127.0.0.1:$PORTA" \
    npx next start -p "$PORTA" > "$TMP/servidor.log" 2>&1 &
  SERVIDOR=$!

  pronto=0
  for _ in $(seq 1 60); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORTA/login" || true)" = "200" ]; then
      pronto=1; break
    fi
    sleep 1
  done

  if [ "$pronto" -ne 1 ]; then
    tail -15 "$TMP/servidor.log"
    marcar 'servidor' 'ABORTOU' 'não subiu em 60s'
    falhas=$((falhas+1))
  else
    marcar 'servidor' 'ok' "porta $PORTA"
    rodar_suite demo/tests/local/telas.spec.mjs 'telas (varredura)'

    for rodada in $(seq 1 "$DUAS"); do
      [ "$DUAS" -eq 2 ] && titulo "   rodada $rodada de 2"
      for f in demo/tests/local/*.spec.mjs; do
        [ "$(basename "$f")" = 'telas.spec.mjs' ] && continue
        rodar_suite "$f" "$(basename "$f" .spec.mjs)$([ "$DUAS" -eq 2 ] && echo " ($rodada)")"
      done
    done

    kill "$SERVIDOR" 2>/dev/null; SERVIDOR=''
    if ! liberar_porta; then
      marcar 'liberar porta' 'ABORTOU' "porta $PORTA não caiu em 30s"
      falhas=$((falhas+1))
    fi
  fi

  # `aplicacao.spec.mjs` sobe o PRÓPRIO servidor na mesma porta e recusa rodar
  # se ela estiver ocupada — por isso vem depois de encerrar o de cima.
  rodar_suite demo/tests/aplicacao.spec.mjs 'aplicacao'
fi

# -----------------------------------------------------------------------------
titulo 'Relatório'
# -----------------------------------------------------------------------------
printf '%s\n' "${linhas[@]}"
echo
if [ "$mortes" -gt 0 ]; then
  echo "$mortes suíte(s) MORRERAM antes de medir — isso não é falha, é ausência de medição."
fi
if [ "$falhas" -eq 0 ]; then
  echo 'VARREDURA LIMPA'
  rm -rf "$GUARDA"
else
  echo "$falhas item(ns) com problema"
  if [ -n "$(ls -A "$GUARDA" 2>/dev/null)" ]; then
    echo "a saída de quem reprovou ficou em .verificacao/"
  fi
fi
exit $(( falhas > 0 ? 1 : 0 ))
