import { faixaDeMeses, mesesEntre, somarMeses } from './competencia'

/**
 * O cronograma: a árvore de tarefas e as barras do Gantt.
 *
 * ## O que esta camada faz, e por que ela não está na tela
 *
 * Três coisas que a tela erraria se as recalculasse: a ordem de leitura da
 * hierarquia, a barra agregada de um grupo comprimido e a posição de cada barra
 * na faixa de meses. As três são aritmética pura sobre dados que o banco já
 * devolveu — e sendo pura, dá para testar sem navegador, que é o único jeito de
 * um cronograma ser verificável.
 */

export interface TarefaDoCronograma {
  id: string
  parent_task_id: string | null
  name: string
  start_month: string
  planned_end_month: string
  actual_end_month: string | null
  assignee: string | null
  status: string
  meses_atraso: number
  desvio_meses: number
  atrasado: boolean
}

export interface LinhaDoCronograma extends TarefaDoCronograma {
  /** 1 = tarefa principal. */
  nivel: number
  total_subtarefas: number
  /** Quantas tarefas a subárvore inteira tem, para o rótulo do grupo. */
  total_na_subarvore: number
}

/**
 * Tarefas em ordem de leitura: cada principal seguida das suas subtarefas.
 *
 * ## Tarefa cujo pai sumiu volta ao primeiro nível
 *
 * Exclusão lógica do pai deixaria a filha órfã, e uma árvore montada por
 * `parent_task_id` simplesmente não a encontraria — a tarefa desapareceria da
 * tela sem ter sido excluída. Aqui ela volta a ser raiz, que é visível e
 * corrigível. É a mesma decisão do GSTI original.
 */
export function emOrdemDeLeitura(tarefas: readonly TarefaDoCronograma[]): LinhaDoCronograma[] {
  const existentes = new Set(tarefas.map((t) => t.id))
  const porPai = new Map<string | null, TarefaDoCronograma[]>()

  for (const t of tarefas) {
    const chave = t.parent_task_id && existentes.has(t.parent_task_id) ? t.parent_task_id : null
    const lista = porPai.get(chave)
    if (lista) lista.push(t)
    else porPai.set(chave, [t])
  }

  /* Ordena cada nível pelo início e, no empate, pelo nome: sem a segunda chave
     a ordem de duas tarefas do mesmo mês muda entre uma consulta e outra. */
  for (const lista of porPai.values()) {
    lista.sort(
      (a, b) => a.start_month.localeCompare(b.start_month) || a.name.localeCompare(b.name, 'pt-BR'),
    )
  }

  const saida: LinhaDoCronograma[] = []

  /* O teto do laço protege contra ciclo já gravado. A trigger da migração 0037
     impede que um entre, mas um banco restaurado de base antiga pode ter um — e
     laço infinito aqui é a tela que não carrega, sem erro nenhum. */
  const visitadas = new Set<string>()

  function descer(paiId: string | null, nivel: number) {
    for (const t of porPai.get(paiId) ?? []) {
      if (visitadas.has(t.id)) continue
      visitadas.add(t.id)
      const filhas = porPai.get(t.id) ?? []
      const posicao = saida.length
      saida.push({ ...t, nivel, total_subtarefas: filhas.length, total_na_subarvore: 0 })
      descer(t.id, nivel + 1)
      /* A contagem da subárvore só dá para preencher depois de descer: é o
         número de linhas que entraram abaixo desta. */
      saida[posicao]!.total_na_subarvore = saida.length - posicao - 1
    }
  }

  descer(null, 1)
  return saida
}

export interface Barra {
  /** Índice da primeira coluna de mês que a barra ocupa. */
  inicio: number
  /** Quantas colunas. Nunca menor que 1 — um mês é uma coluna. */
  duracao: number
}

export interface BarrasDaLinha {
  planejada: Barra
  realizada: Barra | null
}

/**
 * Onde as barras de uma linha caem na faixa de meses.
 *
 * A barra realizada vai do início ao `actual_end_month`, e só existe quando ele
 * existe: entrega sem data registrada não vira barra, porque desenhar uma barra
 * realizada até o mês corrente faria uma tarefa esquecida parecer em andamento.
 */
export function barrasDaLinha(
  linha: { start_month: string; planned_end_month: string; actual_end_month: string | null },
  meses: readonly string[],
): BarrasDaLinha {
  const primeiro = meses[0]
  if (!primeiro) return { planejada: { inicio: 0, duracao: 0 }, realizada: null }

  const coluna = (competencia: string) =>
    Math.min(Math.max(mesesEntre(primeiro, competencia), 0), meses.length - 1)

  const ini = coluna(linha.start_month)
  const fim = coluna(linha.planned_end_month)
  const planejada: Barra = { inicio: ini, duracao: Math.max(fim - ini + 1, 1) }

  let realizada: Barra | null = null
  if (linha.actual_end_month) {
    const fimReal = coluna(linha.actual_end_month)
    realizada = { inicio: ini, duracao: Math.max(fimReal - ini + 1, 1) }
  }

  return { planejada, realizada }
}

/**
 * O intervalo que um grupo comprimido cobre: da data mais cedo à mais tarde de
 * toda a subárvore, o próprio pai incluído.
 *
 * ## Por que agregado, e não só o pai
 *
 * Esconder as subtarefas **não pode encolher o tempo que elas ocupam**. Um grupo
 * cujo pai vai de março a abril mas tem uma subtarefa até setembro precisa
 * mostrar março–setembro quando comprimido; mostrar março–abril faria o
 * cronograma parecer mais curto exatamente quando alguém o comprimiu para
 * enxergar o todo.
 *
 * O "realizado" do grupo só aparece quando a subárvore **inteira** terminou:
 * uma barra realizada parcial diria que o grupo foi entregue.
 */
export function intervaloDoGrupo(
  linhas: readonly LinhaDoCronograma[],
  indiceDoPai: number,
): { start_month: string; planned_end_month: string; actual_end_month: string | null } {
  const pai = linhas[indiceDoPai]!
  const subarvore = linhas.slice(indiceDoPai, indiceDoPai + 1 + pai.total_na_subarvore)

  let inicio = pai.start_month
  let fim = pai.planned_end_month
  let fimReal: string | null = pai.actual_end_month
  let todasEntregues = pai.actual_end_month !== null

  for (const l of subarvore) {
    if (l.start_month < inicio) inicio = l.start_month
    if (l.planned_end_month > fim) fim = l.planned_end_month
    if (l.actual_end_month === null) {
      todasEntregues = false
    } else if (fimReal === null || l.actual_end_month > fimReal) {
      fimReal = l.actual_end_month
    }
  }

  return {
    start_month: inicio,
    planned_end_month: fim,
    actual_end_month: todasEntregues ? fimReal : null,
  }
}

/**
 * A faixa de meses que o cronograma precisa mostrar.
 *
 * Uma margem de um mês de cada lado, para a barra não encostar na borda — e o
 * mês corrente entra na faixa mesmo quando está fora do projeto, porque o
 * marcador de "hoje" é o que diz se o projeto está atrasado só de olhar.
 */
export function faixaDoCronograma(
  linhas: readonly { start_month: string; planned_end_month: string; actual_end_month: string | null }[],
  hoje: string,
): string[] {
  if (linhas.length === 0) return faixaDeMeses(somarMeses(hoje, -1), somarMeses(hoje, 1))

  let inicio = linhas[0]!.start_month
  let fim = linhas[0]!.planned_end_month
  for (const l of linhas) {
    if (l.start_month < inicio) inicio = l.start_month
    if (l.planned_end_month > fim) fim = l.planned_end_month
    if (l.actual_end_month && l.actual_end_month > fim) fim = l.actual_end_month
  }

  if (hoje < inicio) inicio = hoje
  if (hoje > fim) fim = hoje

  return faixaDeMeses(somarMeses(inicio, -1), somarMeses(fim, 1))
}
