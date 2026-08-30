import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PERMISSION_CATALOG, ROLE_RANK } from './permissions'

/*
 * O protótipo navegável (`demo/sti-tool.html`) carrega uma cópia do catálogo de
 * permissões, porque é um arquivo único sem build e não pode importar deste
 * módulo.
 *
 * Cópia sem cobrança viraria mentira: o protótipo é o que a pessoa vê antes de
 * decidir, e prometer nele um controle que a aplicação não tem é pior que não ter
 * controle no protótipo. Este teste falha no instante em que as duas listas
 * divergem — chave nova só na aplicação, chave inventada só no protótipo, teto de
 * papel diferente.
 */

const HTML = readFileSync('demo/sti-tool.html', 'utf8')

interface DemoEntry {
  key: string
  module: string
  screen: string | null
  action: string | null
  minBaseRole: string
}

function demoCatalog(): DemoEntry[] {
  const bloco = HTML.match(/const PERM_CATALOG = \[([\s\S]*?)\n {2}\];/)
  expect(bloco, 'o protótipo precisa declarar PERM_CATALOG').not.toBeNull()

  const linha =
    /\['([a-z_.]+)','([a-z_]+)',(null|'[a-z_]+'),(null|'[a-z_]+'),'[^']*','([a-z_]+)'\]/g
  const out: DemoEntry[] = []
  for (const m of bloco![1]!.matchAll(linha)) {
    const desaspa = (v: string) => (v === 'null' ? null : v.slice(1, -1))
    out.push({
      key: m[1]!,
      module: m[2]!,
      screen: desaspa(m[3]!),
      action: desaspa(m[4]!),
      minBaseRole: m[5]!,
    })
  }
  return out
}

describe('catálogo do protótipo × catálogo da aplicação', () => {
  it('as duas listas são idênticas, na mesma ordem', () => {
    const app = PERMISSION_CATALOG.map((p) => ({
      key: p.key,
      module: p.module,
      screen: p.screen,
      action: p.action,
      minBaseRole: p.minBaseRole as string,
    }))
    expect(demoCatalog()).toEqual(app)
  })

  it('a tabela de patente dos papéis é a mesma', () => {
    /*
     * Isto já divergiu de verdade: o protótipo tinha `solicitante:1,
     * visualizador:2` — invertido e deslocado. O efeito não era cosmético. O
     * solicitante perdia `helpdesk.tickets.ver` e abria a ferramenta sem menu, e
     * o visualizador, que é só leitura, ganhava `helpdesk.tickets.criar`. Nada
     * disso aparecia na comparação do catálogo, porque o catálogo estava certo:
     * o que estava errado era a régua que decide o que cada perfil alcança.
     */
    const bloco = HTML.match(/const ROLE_RANK = \{([^}]*)\}/)
    expect(bloco, 'o protótipo precisa declarar ROLE_RANK').not.toBeNull()

    const doDemo: Record<string, number> = {}
    for (const m of bloco![1]!.matchAll(/([a-z_]+)\s*:\s*(\d+)/g)) {
      doDemo[m[1]!] = Number(m[2])
    }
    expect(doDemo).toEqual(ROLE_RANK)
  })

  it('as regras dos perfis financeiros acompanham a migração 0020', () => {
    /*
     * A comparação de catálogo NÃO pega este tipo de divergência, e isso já
     * aconteceu: o catálogo estava certo e as REGRAS dos perfis eram as antigas,
     * então no protótipo o Operador Financeiro não lançava despesa e o Aprovador
     * não aprovava. O sintoma era um botão ausente, não um erro.
     *
     * Aqui a checagem é textual porque a regra é função nos dois lados e não há
     * como comparar código; o que se cobra é que a decisão esteja escrita. A
     * prova de comportamento é o teste de navegador em demo/tests.
     */
    expect(HTML, 'operador precisa alcançar criar/editar/anexar nos títulos').toContain(
      "['titulos_pagar','titulos_receber'].includes(s)",
    )
    expect(HTML, 'aprovador precisa alcançar aprovar em títulos a pagar').toContain(
      "(s === 'titulos_pagar' && a === 'aprovar')",
    )
  })

  it('o protótipo aplica a mesma regra de herança de negação', () => {
    // Não executa o JS do protótipo; confere que a regra está escrita lá. Uma
    // cópia que devolvesse `granted.has(key)` puro liberaria a ação com o módulo
    // negado, e a demonstração ensinaria a regra errada.
    expect(HTML).toContain('for (let i = 1; i <= parts.length; i++)')
    expect(HTML).toContain("if (!granted.has(parts.slice(0, i).join('.'))) return false;")
  })
})
