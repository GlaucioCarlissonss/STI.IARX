import { diasEmOperacao } from './rotulos'

/**
 * O cálculo da fatura de locação.
 *
 * ## Por que é função pura, aqui, e não SQL
 *
 * Porque esta é a conta que o cliente confere linha a linha, e ela precisa de
 * teste de mesa — entrega no dia 20, devolução no meio do mês, franquia zerada,
 * medidor trocado. Em SQL, cada um desses casos exigiria um banco de pé para
 * ser exercitado; aqui são seis asserções que rodam em milissegundos.
 *
 * O banco guarda o resultado e **garante que o total é a soma das linhas**
 * (gatilho da 0050). A divisão é essa: a conta é testável aqui, a consistência
 * é inviolável lá.
 *
 * ## A regra do pró-rata
 *
 * O mês é cobrado proporcionalmente aos dias em que a peça esteve em operação,
 * e o dia da entrega conta como dia de uso. Entrega em 20 de um mês de 30 cobra
 * 11 dias — não 10. É a convenção da locação, e é a que o cliente espera ver.
 *
 * ## O excedente
 *
 * Franquia é o que já está incluso no preço. O excedente é o que passou dela,
 * medido pela diferença entre a leitura do fim e a do começo do período. Sem
 * leitura no período, **não se cobra excedente** — e a linha não aparece, em
 * vez de aparecer zerada: zero cobrado e "não medimos" são coisas diferentes, e
 * a fatura não deve dizer uma pela outra.
 */

export interface AlocacaoParaFatura {
  contract_item_id: string
  equipment_id: string
  asset_tag: string
  descricao: string
  monthly_price: number
  franchise: number | null
  excess_price: number | null
  delivered_on: string | null
  returned_on: string | null
  /** Leitura no começo da competência (ou na entrega, se foi dentro dela). */
  meter_inicio: number | null
  /** Leitura no fim da competência (ou na devolução). */
  meter_fim: number | null
}

export interface LinhaDaFatura {
  contract_item_id: string | null
  equipment_id: string | null
  kind: 'rent' | 'excess' | 'service' | 'part' | 'discount'
  description: string
  quantity: number
  unit_price: number
  amount: number
  meter_from: number | null
  meter_to: number | null
  days: number | null
}

/** Arredonda para centavos sem acumular erro de ponto flutuante. */
const centavos = (n: number) => Math.round(n * 100) / 100

/** O primeiro e o último dia da competência, em horário local. */
export function limitesDaCompetencia(competencia: string): { inicio: Date; fim: Date; dias: number } {
  const inicio = new Date(`${competencia.slice(0, 7)}-01T00:00:00`)
  const fim = new Date(inicio.getFullYear(), inicio.getMonth() + 1, 0)
  return { inicio, fim, dias: fim.getDate() }
}

export function calcularFatura(
  competencia: string,
  alocacoes: AlocacaoParaFatura[],
): LinhaDaFatura[] {
  const { inicio, fim, dias: diasDoMes } = limitesDaCompetencia(competencia)
  const linhas: LinhaDaFatura[] = []

  for (const a of alocacoes) {
    const dias = diasEmOperacao(inicio, fim, a.delivered_on, a.returned_on)
    if (dias <= 0) continue

    /* Mês cheio não vira "30/30 dias" na descrição: dizer "proporcional" onde
       não houve proporção confunde quem confere. */
    const cheio = dias >= diasDoMes
    const valor = cheio ? a.monthly_price : (a.monthly_price * dias) / diasDoMes

    linhas.push({
      contract_item_id: a.contract_item_id,
      equipment_id: a.equipment_id,
      kind: 'rent',
      description: cheio
        ? `Locação — ${a.asset_tag} ${a.descricao}`
        : `Locação proporcional (${dias}/${diasDoMes} dias) — ${a.asset_tag} ${a.descricao}`,
      quantity: cheio ? 1 : dias,
      unit_price: cheio ? centavos(a.monthly_price) : centavos(a.monthly_price / diasDoMes),
      amount: centavos(valor),
      meter_from: null,
      meter_to: null,
      days: dias,
    })

    /* Sem medição no período, nenhuma linha de excedente. Ver o comentário do
       módulo: zero cobrado e "não medimos" não são a mesma coisa. */
    if (a.meter_inicio === null || a.meter_fim === null) continue
    if (a.excess_price === null || a.excess_price <= 0) continue

    const consumo = Math.max(0, a.meter_fim - a.meter_inicio)
    /* A franquia também é proporcional: meio mês de uso tem meia franquia, ou
       quem entra no dia 25 pagaria excedente de um mês inteiro de inclusão. */
    const franquia = a.franchise === null ? 0 : cheio ? a.franchise : (a.franchise * dias) / diasDoMes
    const excedente = consumo - franquia
    if (excedente <= 0) continue

    linhas.push({
      contract_item_id: a.contract_item_id,
      equipment_id: a.equipment_id,
      kind: 'excess',
      description: `Excedente de franquia (${centavos(excedente)} além de ${centavos(franquia)}) — ${a.asset_tag}`,
      quantity: centavos(excedente),
      unit_price: a.excess_price,
      amount: centavos(excedente * a.excess_price),
      meter_from: a.meter_inicio,
      meter_to: a.meter_fim,
      days: dias,
    })
  }

  return linhas
}

/** O total, que é sempre a soma das linhas — nunca um número à parte. */
export function totalDaFatura(linhas: LinhaDaFatura[]): number {
  return centavos(linhas.reduce((s, l) => s + l.amount, 0))
}
