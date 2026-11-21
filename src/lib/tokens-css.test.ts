import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * TODO TOKEN DE CSS USADO É DECLARADO.
 *
 * Por que isto precisa de portão
 * ------------------------------
 * `color: var(--inexistente)` **não é erro**. O navegador descarta a declaração
 * inteira, em silêncio, e a propriedade herda do pai. Não há aviso no console,
 * não há linha vermelha, não há nada: a tela simplesmente fica com a cor de
 * outra coisa.
 *
 * E o pior é que a conferência de acessibilidade pode APROVAR isso — ela mede a
 * cor que o elemento acabou tendo, não a que o código pediu. Se a cor herdada
 * por acaso tiver contraste, o defeito atravessa o portão de contraste de
 * cabeça erguida.
 *
 * O que ele achou ao nascer
 * -------------------------
 * Três usos, todos em `sistema/planilhas/gaveta.tsx`:
 *
 *  · `--color-info-soft` e `--color-info-ink` — a rampa `info` nunca existiu
 *    nesta paleta. A caixa de dica da gaveta de planilhas ficava sem fundo
 *    nenhum e com a cor de texto do pai;
 *  · `--color-breach` sem sufixo — existem `--color-breach-ink` e
 *    `--color-breach-soft`, e a borda da linha recusada caía no padrão do
 *    Tailwind em vez do vermelho. A linha recusada parecia uma linha comum.
 *
 * Nenhum dos três quebrava nada. É exatamente por isso que duraram.
 *
 * Como ele lê
 * -----------
 * O token pode ser declarado no CSS **ou** injetado por `style` em React
 * (`{['--scroll-duration']: ...}`), que é como o painel de TV passa a duração
 * da marquise. As duas formas contam como declaração: o que o portão proíbe é
 * o token que ninguém define em lugar nenhum.
 */

const RAIZ = 'src'

function arquivos(dir: string, achados: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name)
    if (entrada.isDirectory()) arquivos(caminho, achados)
    else if (/\.(tsx?|css)$/.test(entrada.name)) achados.push(caminho)
  }
  return achados
}

/*
 * As suítes ficam de fora: este arquivo cita `var(--inexistente)` na própria
 * explicação, e uma peneira que lê a si mesma reprova por causa do exemplo que
 * ela usa para dizer o que reprova.
 */
const ARQUIVOS = arquivos(RAIZ).filter((f) => !/\.test\.tsx?$/.test(f))
/*
 * O COMENTÁRIO SAI ANTES DA PENEIRA.
 *
 * Citar `var(--inexistente)` ao explicar por que um token errado é perigoso é
 * uma MENÇÃO, não um uso — e o portão reprovou a própria correção que o deixou
 * verde, porque o comentário que explicava o conserto citava o token consertado.
 *
 * Só comentário de bloco é removido. Tirar `//` também arrancaria o meio de
 * toda URL `https://`, e o que se ganharia não paga o que se perderia.
 */
const semComentarios = (texto: string) =>
  texto.replace(/\/\*[\s\S]*?\*\//g, (bloco) => bloco.replace(/[^\n]/g, ' '))

const FONTE = new Map(ARQUIVOS.map((f) => [f, semComentarios(readFileSync(f, 'utf8'))]))

/** Onde cada token é USADO, com o primeiro arquivo em que aparece. */
function usados(): Map<string, string> {
  const out = new Map<string, string>()
  for (const [arquivo, texto] of FONTE) {
    /*
     * O `[,)]` no fim é o que separa USO de MENÇÃO, e os dois casos reais são:
     *
     *  · `var(--color-marker-*)` numa explicação, onde o `*` é curinga de prosa;
     *  · `var(--color-marker-${cor})`, nome montado em tempo de execução.
     *
     * Nos dois o nome não é um token: é um molde. Exigir que o molde exista
     * seria proibir o padrão — e é por isso que o mapa declara as três cores
     * num bloco só, onde a lista inteira se lê de uma vez.
     */
    for (const m of texto.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*[,)]/g)) {
      const token = m[1]!
      if (!out.has(token)) out.set(token, arquivo)
    }
  }
  return out
}

/** Todo token DECLARADO: no CSS, ou injetado por `style` num componente. */
function declarados(): Set<string> {
  const out = new Set<string>()
  for (const [arquivo, texto] of FONTE) {
    if (arquivo.endsWith('.css')) {
      for (const m of texto.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) out.add(m[1]!)
    }
    /* `style={{ ['--scroll-duration' as string]: ... }}` — declaração em linha,
       que é o caminho legítimo para um valor que só o componente conhece. */
    for (const m of texto.matchAll(/\[\s*'(--[A-Za-z0-9_-]+)'/g)) out.add(m[1]!)
  }
  return out
}

describe('tokens de CSS', () => {
  it('todo token usado em var() está declarado em algum lugar', () => {
    const decl = declarados()
    const faltando = [...usados()]
      .filter(([token]) => !decl.has(token))
      .map(([token, arquivo]) => `${token} (usado em ${arquivo})`)

    expect(
      faltando,
      'estes tokens não existem: o navegador DESCARTA a declaração inteira em ' +
        'silêncio e a propriedade herda do pai, sem erro no console',
    ).toEqual([])
  })

  it('a peneira enxerga a paleta inteira', () => {
    /*
     * A armadilha do estado vazio suposto, da Parte 5 do padrão. Se a expressão
     * parar de casar — um `var( --x )` com espaço, uma pasta renomeada — as duas
     * listas ficam vazias, a diferença entre elas fica vazia, e o teste acima
     * passa para sempre sem ler uma linha. Os números abaixo são o que existe
     * hoje, com folga para baixo: eles não precisam estar certos, precisam estar
     * longe de zero.
     */
    expect(ARQUIVOS.length, 'o caminho de `src` mudou?').toBeGreaterThan(100)
    expect(usados().size, 'nenhum var() encontrado').toBeGreaterThan(30)
    expect(declarados().size, 'nenhum token declarado encontrado').toBeGreaterThan(30)
  })
})
