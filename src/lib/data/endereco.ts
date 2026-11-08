import type { Route } from 'next'

/**
 * O endereço é o estado da lista.
 *
 * ## Por que filtro, ordem e página moram na URL
 *
 * Porque uma lista filtrada é uma pergunta, e pergunta se manda para outra
 * pessoa. Com o estado em memória, "os chamados críticos da fila de
 * infraestrutura sem atendente" é uma sequência de cliques que precisa ser
 * descrita por escrito no chat; com o estado no endereço, é um link. De quebra,
 * o botão "voltar" do navegador passa a desfazer o último filtro, que é o que
 * todo mundo tenta.
 *
 * ## A regra da página 1
 *
 * Mudou QUALQUER coisa que altere o conjunto — filtro ou ordem —, a página
 * volta para a primeira. Sem isso, filtrar estando na página 7 leva a uma tela
 * vazia de uma lista que tem resultados, e o sintoma ("o filtro não achou
 * nada") aponta para o lugar errado.
 */
export function comParametros(
  base: string,
  params: Record<string, string | undefined>,
  mudancas: Record<string, string | undefined | null>,
): Route {
  const busca = new URLSearchParams()

  for (const [chave, valor] of Object.entries(params)) {
    if (valor) busca.set(chave, valor)
  }

  for (const [chave, valor] of Object.entries(mudancas)) {
    if (valor === null || valor === undefined || valor === '') busca.delete(chave)
    else busca.set(chave, valor)
  }

  // A página é consequência do conjunto, não um filtro: mudou o conjunto, some.
  if (!('pagina' in mudancas)) busca.delete('pagina')

  const qs = busca.toString()
  return (qs ? `${base}?${qs}` : base) as Route
}
