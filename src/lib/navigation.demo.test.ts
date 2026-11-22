import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NAV_GROUPS } from './navigation'

/*
 * O MENU DO PROTÓTIPO × O MENU DA APLICAÇÃO
 * =========================================
 *
 * Este teste existe porque a divergência já aconteceu, e aconteceu grande: a
 * aplicação chegou a 48 telas enquanto `demo/sti-tool.html` ainda mostrava 25.
 * Faltavam a **locação inteira** — frota, contratos, medições, faturamento,
 * manutenção, peças, compras, contagens — e mais dezessete telas de gestão.
 *
 * Mais da metade do produto não existia no único artefato que se abre para
 * mostrar o produto. E nada acusava: o catálogo de permissões estava em dia
 * (`permissions.demo.test.ts` cobrava isso), as telas da aplicação estavam
 * testadas, e a ferramenta abria bonita — só que menor.
 *
 * É o tipo de defeito que cresce em silêncio: cada entrega acrescenta tela na
 * aplicação, ninguém lembra do protótipo, e a diferença só aparece quando
 * alguém abre o arquivo para demonstrar e sente falta do que tinha antes.
 *
 * ## Por que o teste é sobre o MENU, e não sobre as telas
 *
 * O que se cobra aqui é o item de menu com a chave de permissão certa. Se a
 * entrada existe e a chave bate, a tela está alcançável e governada; se o
 * `views[...]` correspondente estiver vazio, isso aparece na suíte de navegador
 * (`demo/tests/prototipo.spec.mjs`), que abre cada destino.
 *
 * Dois níveis, e é deliberado: este roda em milissegundos a cada `npm test` e
 * pega a omissão no mesmo dia; aquele roda com navegador e pega a tela quebrada.
 */

const HTML = readFileSync('demo/sti-tool.html', 'utf8')

/** As entradas que o protótipo declara, lidas do `NAV_GROUPS` dele. */
function menuDoPrototipo(): { chave: string; rotulo: string; permissao: string | null }[] {
  const bloco = HTML.match(/const NAV_GROUPS = \[([\s\S]*?)\n {2}\];/)
  expect(bloco, 'o protótipo precisa declarar NAV_GROUPS').not.toBeNull()

  /* `['chave','Rótulo',novo,'permissao'...]` — e também `[null,'Rótulo',...]`,
     que são os itens "em breve", sem destino. Estes últimos ficam de fora: eles
     anunciam o que ainda não existe, e cobrar deles paridade seria cobrar que a
     aplicação tenha o que o protótipo promete. */
  const linha = /\['([a-z0-9-]+)','([^']+)',(?:true|false),(null|'[a-z_.]+')/g
  const out: { chave: string; rotulo: string; permissao: string | null }[] = []
  for (const m of bloco![1]!.matchAll(linha)) {
    out.push({
      chave: m[1]!,
      rotulo: m[2]!,
      permissao: m[3] === 'null' ? null : m[3]!.slice(1, -1),
    })
  }
  return out
}

/**
 * As telas da aplicação, achatadas.
 *
 * `NAV_GROUPS` da aplicação é a fonte: ele é o que o usuário vê, e é o que
 * cresce a cada entrega.
 */
function menuDaAplicacao(): { href: string; rotulo: string; permissao: string | null }[] {
  return NAV_GROUPS.flatMap((g) =>
    g.items
      /* Os itens `soon` não são tela: são um anúncio do que ainda não existe,
         com `href: null`. Cobrá-los do protótipo seria exigir que ele
         implemente o que a aplicação também não implementou. */
      .filter((i): i is typeof i & { href: string } => !i.soon && typeof i.href === 'string')
      .map((i) => ({
        href: i.href,
        rotulo: i.label,
        permissao: i.permission ?? null,
      })),
  )
}

/*
 * As telas que existem na aplicação e NÃO precisam existir no protótipo.
 *
 * A lista é curta de propósito, e cada linha tem um motivo que não é "ainda não
 * fiz". Uma isenção sem motivo é a porta por onde a divergência volta.
 */
const DISPENSADAS = new Map<string, string>([
  [
    '/conta',
    /* Existe no protótipo com a chave `conta`, fora de grupo — trocar a própria
       senha não é permissão de módulo, é direito de quem tem conta. */
    'existe no protótipo como "conta", fora de grupo',
  ],
])

describe('menu do protótipo × menu da aplicação', () => {
  it('toda tela do menu da aplicação existe no protótipo', () => {
    const proto = new Set(menuDoPrototipo().map((i) => i.rotulo))
    const faltando = menuDaAplicacao()
      .filter((a) => !DISPENSADAS.has(a.href))
      .filter((a) => !proto.has(a.rotulo))
      .map((a) => `${a.rotulo} (${a.href})`)

    expect(
      faltando,
      'telas que a aplicação tem e o protótipo não — o artefato que se abre para ' +
        'demonstrar o produto estaria mostrando menos do que o produto é',
    ).toEqual([])
  })

  it('a chave de permissão de cada tela é a mesma nos dois', () => {
    /*
     * Rótulo igual com chave diferente é pior que tela faltando: a demonstração
     * mostra um controle que a aplicação não aplica, ou esconde um que ela
     * aplica. Foi assim que "Links de internet" ficou sem chave por uma entrega
     * inteira, visível para o financeiro.
     */
    const porRotulo = new Map(menuDoPrototipo().map((i) => [i.rotulo, i.permissao]))
    const divergentes: string[] = []

    for (const a of menuDaAplicacao()) {
      if (DISPENSADAS.has(a.href)) continue
      if (!porRotulo.has(a.rotulo)) continue // já cobrado no teste acima
      const noProto = porRotulo.get(a.rotulo)!
      if (noProto !== a.permissao) {
        divergentes.push(`${a.rotulo}: aplicação=${a.permissao} protótipo=${noProto}`)
      }
    }

    expect(divergentes).toEqual([])
  })

  it('o protótipo não inventa tela que a aplicação não tem', () => {
    /*
     * O outro lado da mesma moeda. Tela só no protótipo é promessa: quem vê a
     * demonstração compra uma coisa e recebe outra.
     *
     * As três exceções são do próprio artefato e não existem como tela do
     * produto — são sobre o artefato.
     */
    const SO_DO_ARTEFATO = new Set([
      'Novidades',
      'Mapa do menu',
      'Peças incorporadas',
      /* As capturas da aplicação rodando. É sobre o produto, e não é tela do
         produto — cobrar dela uma rota em `NAV_GROUPS` seria exigir que a
         aplicação tivesse uma tela que mostra fotos de si mesma. */
      'Telas da aplicação',
      /* O dicionário de dados e os artefatos SQL. Mesma natureza: é sobre o
         schema, não uma tela do produto. Quem cobra que ele acompanhe o banco
         é o gerador, com `--conferir`, e não este teste. */
      'Banco de dados',
      'Minha conta',
    ])
    const app = new Set(menuDaAplicacao().map((i) => i.rotulo))

    const sobrando = menuDoPrototipo()
      .filter((p) => !SO_DO_ARTEFATO.has(p.rotulo))
      .filter((p) => !app.has(p.rotulo))
      .map((p) => p.rotulo)

    expect(sobrando, 'telas que só o protótipo tem — demonstração promete o que não existe').toEqual(
      [],
    )
  })
})
