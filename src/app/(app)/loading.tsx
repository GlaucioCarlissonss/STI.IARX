import { PageSkeleton } from '@/components/ui'

/**
 * O que aparece enquanto qualquer tela da aplicação carrega.
 *
 * ## Por que UM arquivo cobre as 25 telas
 *
 * No App Router, `loading.tsx` cria um limite de Suspense em volta do `children`
 * do layout do segmento — e vale para todo segmento abaixo que não tenha o seu.
 * Como todas as telas autenticadas são filhas deste layout, um arquivo basta. A
 * alternativa seriam 25 esqueletos para manter em dia com 25 layouts, e
 * esqueleto desatualizado promete uma forma que não chega.
 *
 * ## O que isso conserta
 *
 * Antes não havia nenhum: ao clicar em "Inventário", a tela anterior ficava
 * parada na frente da pessoa até a última consulta voltar. Sem sinal nenhum de
 * que algo estava acontecendo, o clique parecia não ter funcionado — e o segundo
 * clique, esse sim, atrapalhava. Páginas desta aplicação fazem até dez consultas;
 * a espera é real e precisa ser dita.
 *
 * O cabeçalho e o menu continuam na tela durante a troca, porque o limite está
 * DENTRO do layout. Isso é metade do valor: a pessoa não perde o contexto nem a
 * posição do menu enquanto espera.
 */
export default function Loading() {
  return <PageSkeleton />
}
