import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NAV_GROUPS } from './navigation'

/*
 * TODA TELA DO MENU É VISITADA PELA VARREDURA.
 *
 * `demo/tests/local/telas.spec.mjs` abre cada rota autenticada e confere que
 * ela responde, não quebra e não é uma casca vazia. É a rede que pega a tela
 * que deixou de carregar depois de uma migração — e ela só pega o que está na
 * sua lista, que é escrita à mão.
 *
 * Esta é a TERCEIRA lista desta base que uma tela nova escapou em silêncio:
 *
 *  · o menu do protótipo (26 telas atrás, `navigation.demo.test.ts`);
 *  · o "Mapa do menu" do artefato, que listava telas sem destino;
 *  · e esta varredura, onde `/assinatura` entrou no menu e não na lista.
 *
 * O padrão é sempre o mesmo: a lista escrita à mão envelhece em silêncio, e a
 * falta não produz erro nenhum — produz uma cobertura menor que ninguém mede.
 * Por isso a terceira ocorrência virou teste em vez de virar mais uma correção.
 *
 * Roda em milissegundos a cada `npm test`, e falha no mesmo dia em que a tela
 * nasce.
 */

const SPEC = readFileSync('demo/tests/local/telas.spec.mjs', 'utf8')

function rotasDaVarredura(): Set<string> {
  const bloco = SPEC.match(/const ROTAS = \[([\s\S]*?)\n\]/)
  expect(bloco, 'telas.spec.mjs precisa declarar ROTAS').not.toBeNull()
  return new Set([...bloco![1]!.matchAll(/^\s*'(\/[^']*)'/gm)].map((m) => m[1]!))
}

function rotasDoMenu(): string[] {
  return NAV_GROUPS.flatMap((g) =>
    g.items
      /* Itens `soon` não têm destino (`href: null`): são um anúncio do que
         ainda não existe, e não há o que varrer neles. */
      .filter((i): i is typeof i & { href: string } => !i.soon && typeof i.href === 'string')
      .map((i) => i.href),
  )
}

describe('a varredura de telas cobre o menu inteiro', () => {
  it('toda rota do menu está na lista de ROTAS', () => {
    const varridas = rotasDaVarredura()
    const faltando = rotasDoMenu().filter((h) => !varridas.has(h))

    expect(
      faltando,
      'telas que o menu oferece e a varredura não abre — elas podem quebrar ' +
        'numa migração e nenhuma suíte perceberia',
    ).toEqual([])
  })

  it('a varredura não visita rota que o menu não oferece', () => {
    /*
     * O outro lado: uma rota que saiu do menu e ficou na lista faz a varredura
     * gastar tempo numa tela que ninguém alcança — e, quando ela quebrar, o
     * vermelho será sobre algo que não está mais no produto.
     *
     * A exceção legítima é a SUBTELA: uma tela de verdade, alcançada por link
     * a partir da sua, que não merece linha no menu. Cada uma está listada
     * abaixo com o motivo — isenção sem motivo é a porta por onde a divergência
     * volta.
     */
    const doMenu = new Set(rotasDoMenu())
    const FORA_DO_MENU_POR_DESENHO = new Set([
      /*
       * SUBTELA, alcançada a partir da sua. `/conversas/canais` é configuração
       * dos canais e tem link em `/conversas` (page.tsx, linha ~115). Pô-la no
       * menu faria o grupo de Atendimento crescer para incluir uma tela de
       * configuração que só quem administra abre, e uma vez por mês.
       *
       * Varrer continua valendo: ela é uma tela de verdade, e quebrar numa
       * migração quebraria igual às outras. O que ela não é, é item de menu.
       */
      '/conversas/canais',
    ])

    const sobrando = [...rotasDaVarredura()].filter(
      (r) => !doMenu.has(r) && !FORA_DO_MENU_POR_DESENHO.has(r),
    )

    expect(sobrando, 'rotas varridas que não existem mais no menu').toEqual([])
  })
})
