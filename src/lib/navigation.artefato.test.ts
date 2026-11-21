import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * TODO ARQUIVO QUE O ARTEFATO OFERECE EXISTE DE VERDADE.
 *
 * O defeito que originou este teste
 * ---------------------------------
 * A tela "Peças incorporadas" listava cinco páginas com um botão `Abrir ›` cada
 * uma, apontando para `pecas/*.html`. Nenhum dos cinco arquivos estava no
 * repositório: eles vinham de projetos anteriores e nunca foram trazidos.
 *
 * Aberto como arquivo local, o botão não fazia nada. Publicado como artefato,
 * ele levava a uma página que o servidor não tem. E o pior: a tela se chama
 * "Peças incorporadas" e afirma em voz alta que "tudo o que estava espalhado
 * passou a morar aqui" — ela prometia precisamente o que não entregava.
 *
 * Nenhuma suíte acusava. `prototipo.spec.mjs` abre cada DESTINO do menu e
 * confere que a tela renderiza; ela renderizava. O que ela não fazia era clicar
 * num link que sai da tela — e é aí que o artefato depende de um arquivo.
 *
 * Por que o teste é sobre o LITERAL, e não sobre o DOM
 * ---------------------------------------------------
 * Varrer o DOM renderizado só alcança o que a tela mostra no estado em que ela
 * nasce. O caminho mora num literal do código, e o literal está lá mesmo que
 * ninguém abra a tela. Ler o literal pega os cinco de uma vez, em milissegundos,
 * sem navegador — e pega o sexto no dia em que ele for escrito.
 *
 * O que ele NÃO cobre, dito em voz alta: caminho montado por concatenação
 * (`'telas/' + nome`) escapa desta peneira. Por isso os caminhos do artefato se
 * escrevem inteiros, num literal só.
 */

const DEMO = 'demo'
const HTML = readFileSync(join(DEMO, 'sti-tool.html'), 'utf8')

/** Literais que parecem caminho de arquivo relativo, com extensão conhecida. */
function caminhosOferecidos(): string[] {
  const achados = new Set<string>()
  for (const m of HTML.matchAll(/['"]([A-Za-z0-9_./-]+\.(?:html|png|webp|jpe?g|svg|css|js|json))['"]/g)) {
    const caminho = m[1]!
    /* Caminho absoluto e URL de fora não são arquivo deste repositório. */
    if (caminho.startsWith('/') || caminho.includes('://')) continue
    /* Sem barra é quase sempre nome de outra coisa (classe, chave); o que o
       artefato serve mora sempre numa pasta ao lado dele. */
    if (!caminho.includes('/')) continue
    achados.add(caminho)
  }
  return [...achados].sort()
}

describe('o artefato não oferece arquivo que não existe', () => {
  it('todo caminho relativo escrito no protótipo está no disco', () => {
    const faltando = caminhosOferecidos().filter((c) => !existsSync(join(DEMO, c)))

    expect(
      faltando,
      'o protótipo oferece estes arquivos e eles não estão em `demo/` — ' +
        'publicado como artefato, cada um vira um botão que não leva a lugar nenhum',
    ).toEqual([])
  })

  it('a peneira enxerga alguma coisa', () => {
    /*
     * A armadilha do estado vazio suposto, da Parte 5 do padrão: se a expressão
     * parar de casar (uma aspa trocada, uma extensão nova), `faltando` fica
     * vazio e o teste acima passa para sempre sem conferir nada. Esta asserção
     * é o que impede o verde silencioso.
     */
    expect(caminhosOferecidos().length).toBeGreaterThan(0)
  })
})
