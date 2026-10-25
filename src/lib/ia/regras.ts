import type {
  ConfigDeIA,
  MotivoDeIndisponibilidade,
  TipoDeSugestao,
  TriagemSugerida,
} from './tipos'
import { credencialDaIA } from './tipos'

/**
 * As decisões que não dependem de rede nem de banco — e por isso são as que dá
 * para testar de verdade.
 */

/**
 * Por que não dá para pedir sugestão agora, ou `null` se dá.
 *
 * ## A ordem importa
 *
 * "Desligada" vem antes de "sem orçamento" porque quem não ligou a IA não quer
 * saber do orçamento dela. E "variável ausente" vem por último porque ele é o
 * mais específico dos cinco: o nome está certo no banco e a variável não existe no
 * servidor — o erro de quem configurou a tela e esqueceu o ambiente, que é o mais
 * comum de todos e o que mais se parece com "está quebrado".
 */
export function porQueNaoPosso(
  config: ConfigDeIA | null,
  tipo: TipoDeSugestao,
): MotivoDeIndisponibilidade | null {
  if (!config || !config.enabled) return 'desligada'
  if (!config.secret_ref) return 'sem_credencial'

  const ligado: Record<TipoDeSugestao, boolean> = {
    resposta: config.sugerir_resposta,
    triagem: config.sugerir_triagem,
    artigo: config.redigir_artigo,
  }
  if (!ligado[tipo]) return 'recurso_desligado'

  /* O orçamento é conferido ANTES da chamada. Depois já gastou. */
  if (!config.tem_orcamento) return 'sem_orcamento'

  if (!credencialDaIA(config.secret_ref)) return 'variavel_ausente'

  return null
}

/**
 * Converte o que o modelo escolheu nos ids que o banco usa.
 *
 * ## Por que não pedir o uuid direto ao modelo
 *
 * Porque uuid inventado é indistinguível de uuid verdadeiro até o `update`
 * falhar — e, com azar, pode ser o uuid de OUTRA categoria existente, aplicando
 * em silêncio a classificação errada. Nome e chave são legíveis, são conferidos
 * contra a lista que foi enviada no prompt, e o que não existe é recusado aqui,
 * antes de virar sugestão.
 *
 * Ausente (`null`) é resultado legítimo: o prompt pede explicitamente para
 * devolver null quando o chamado não dá base para escolher. Null honesto vale mais
 * que um palpite que alguém aceita sem conferir.
 */
export function resolverTriagem(
  dados: TriagemSugerida,
  categorias: { id: string; name: string }[],
  prioridades: { id: string; key: string; label: string }[],
):
  | {
      ok: true
      category_id: string | null
      category_name: string | null
      priority_id: string | null
      priority_name: string | null
    }
  | { ok: false; erro: string } {
  let category_id: string | null = null
  let category_name: string | null = null
  if (dados.categoria_nome) {
    const alvo = dados.categoria_nome.trim().toLowerCase()
    /* Sem acento e sem caixa: o modelo escreve "Impressoras" onde o cadastro diz
       "impressoras", e recusar por isso seria perder a sugestão por um detalhe
       de digitação. */
    const achadas = categorias.filter((c) => c.name.trim().toLowerCase() === alvo)
    if (achadas.length === 0) {
      return {
        ok: false,
        erro: `A categoria sugerida ("${dados.categoria_nome}") não existe no cadastro.`,
      }
    }
    /*
     * Nome de categoria é único por (tenant, categoria-pai) — não por tenant. Duas
     * subcategorias "Senha", uma sob "Acesso" e outra sob "E-mail", são legítimas,
     * e aí o nome não diz qual é. Escolher a primeira aplicaria a classificação
     * errada em silêncio, que é o defeito que este módulo inteiro evita.
     */
    if (achadas.length > 1) {
      return {
        ok: false,
        erro: `Há mais de uma categoria chamada "${dados.categoria_nome}". Classifique à mão.`,
      }
    }
    category_id = achadas[0]!.id
    category_name = achadas[0]!.name
  }

  let priority_id: string | null = null
  let priority_name: string | null = null
  if (dados.prioridade_chave) {
    const achada = prioridades.find((p) => p.key === dados.prioridade_chave)
    if (!achada) {
      return {
        ok: false,
        erro: `A prioridade sugerida ("${dados.prioridade_chave}") não existe no cadastro.`,
      }
    }
    priority_id = achada.id
    priority_name = achada.label
  }

  /* Sugestão que não sugere nada não vira linha: ela ocuparia o índice único de
     pendente por chamado, e o painel mostraria um cartão vazio com um botão de
     aceitar que não faria nada. */
  if (!category_id && !priority_id) {
    return {
      ok: false,
      erro: 'O modelo não conseguiu classificar este chamado — faltou informação nele.',
    }
  }

  return { ok: true, category_id, category_name, priority_id, priority_name }
}

/**
 * Como a tela trata a confiança declarada.
 *
 * Três faixas, e não um número na tela: "0,73" convida a comparar precisão que
 * não existe. O que a pessoa precisa saber é se lê a sugestão como resposta ou
 * como ponto de partida.
 */
export function faixaDeConfianca(c: number): { rotulo: string; tom: 'ok' | 'warn' | 'neutral' } {
  if (c >= 0.75) return { rotulo: 'confiança alta', tom: 'ok' }
  if (c >= 0.45) return { rotulo: 'confiança média', tom: 'neutral' }
  return { rotulo: 'confiança baixa — trate como ponto de partida', tom: 'warn' }
}

/** Centavos de dólar como a tela escreve. */
export function centavosEmDolar(centavos: number): string {
  return `US$ ${(centavos / 100).toFixed(2)}`
}
