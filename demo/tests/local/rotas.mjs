/*
 * AS ROTAS AUTENTICADAS DO PRODUTO — uma lista só, importada por quem mede.
 *
 * Por que ela saiu de dentro da suíte
 * -----------------------------------
 * `telas.spec.mjs` abre cada rota e confere que ela responde; `refluxo.spec.mjs`
 * abre as mesmas rotas a 320px e confere que nenhuma rola para o lado. Com a
 * lista escrita duas vezes, a que ficasse para trás mediria menos — sem avisar,
 * e justamente nas telas novas, que são as que mais precisam ser medidas.
 *
 * Quem cobra que esta lista acompanhe o menu é `navigation.varredura.test.ts`,
 * nos dois sentidos: tela do menu que não está aqui, e rota aqui que saiu do
 * menu.
 */

export const ROTAS = [
  '/painel',
  '/portal',
  '/resultado',
  '/tickets',
  '/tickets/novo',
  /* Locação (0048). Entram aqui como qualquer outra: a varredura confere que a
     rota responde 200, sem erro de servidor nem de hidratação. */
  '/locacao/frota',
  '/locacao/cadastros',
  '/locacao/contratos',
  '/locacao/medicoes',
  '/locacao/faturamento',
  '/locacao/manutencao',
  '/locacao/pecas',
  '/locacao/compras',
  '/locacao/contagens',
  '/sistema/planilhas',
  '/filas',
  '/sla',
  '/sla/horarios',
  '/satisfacao',
  '/base',
  '/catalogo',
  '/conversas',
  '/conversas/canais',
  '/projetos',
  '/financeiro/titulos-a-pagar',
  '/financeiro/titulos-a-receber',
  '/financeiro/contas-bancarias',
  '/financeiro/centros-de-custo',
  '/financeiro/fluxo-de-caixa',
  '/financeiro/orcamento',
  '/inventario',
  '/inventario/agentes',
  '/inventario/software',
  '/telefonia',
  '/conectividade/links',
  '/mapas',
  '/clientes',
  '/fornecedores',
  '/integracoes',
  '/usuarios',
  /* Convites (0061). Tela nova entra na varredura no mesmo commit em que
     nasce: é aqui que se descobre que ela quebra com a lista vazia, com o
     driver local, ou com um erro de hidratação que nenhuma asserção de
     comportamento olharia. */
  '/usuarios/convites',
  '/perfis',
  '/tv',
  '/ia',
  '/auditoria',
  '/auditoria/trabalhos',
  /* A caixa de saída (0058), pelo mesmo motivo. */
  '/auditoria/avisos',
  '/ambiente',
  /* A assinatura (0062). Tela nova entra na varredura no mesmo commit em que
     nasce — foi a terceira lista escrita à mão desta base a deixar uma escapar,
     e a que virou `navigation.varredura.test.ts`. */
  '/assinatura',
  '/conta',
]
