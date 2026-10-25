import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { z } from 'zod'
import { custoEmCentavos } from './tipos'

/**
 * A chamada ao provedor, e nada mais.
 *
 * ## Por que o SDK oficial e não `fetch`
 *
 * `fetch` contra a API seria menos uma dependência — e esta base é econômica com
 * dependências de propósito (o agente em Go tem zero). Mas aqui o SDK paga: ele
 * traz a validação do esquema de saída (`zodOutputFormat` + `.parse()`), as
 * classes de erro tipadas, e a nova tentativa com recuo em 429 e 5xx, que são
 * três coisas que teríamos de escrever e manter contra uma API que muda.
 *
 * ## O que esta camada NÃO faz
 *
 * Não decide se pode chamar (isso é orçamento e configuração, no banco), não
 * monta prompt (isso é `prompts.ts`) e não grava nada. Ela recebe prompt +
 * esquema e devolve objeto validado + o que custou. Uma coisa só, testável sem
 * rede.
 */

/** O que uma chamada devolve: o objeto validado e o que ele custou. */
export interface Resultado<T> {
  dados: T
  model: string
  tokens_entrada: number
  tokens_saida: number
  custo_centavos: number
}

export type FalhaDaIA =
  | { tipo: 'credencial'; mensagem: string }
  | { tipo: 'limite'; mensagem: string }
  | { tipo: 'recusa'; mensagem: string }
  | { tipo: 'formato'; mensagem: string }
  | { tipo: 'provedor'; mensagem: string }

export type RespostaDaIA<T> = { ok: true; resultado: Resultado<T> } | { ok: false; falha: FalhaDaIA }

/**
 * Teto de saída por chamada.
 *
 * 4000 tokens cobrem com folga um rascunho de resposta e um artigo inteiro. O
 * motivo de haver teto não é o corte — é o custo: sem ele, um prompt que
 * provocasse uma resposta longa gastaria o orçamento do mês numa chamada.
 */
const MAXIMO_DE_SAIDA = 4000

/**
 * Chama o provedor e devolve o objeto do esquema.
 *
 * `system` vem separado de `pergunta` porque é o que não muda entre as chamadas
 * do mesmo tipo — e é por isso que ele leva `cache_control`: o desconto de leitura
 * em cache vale justamente num prompt de sistema que se repete a cada chamado.
 */
export async function pedirAoProvedor<S extends z.ZodType>({
  credencial,
  model,
  effort,
  system,
  pergunta,
  esquema,
}: {
  credencial: string
  model: string
  effort: 'low' | 'medium' | 'high'
  system: string
  pergunta: string
  esquema: S
}): Promise<RespostaDaIA<z.infer<S>>> {
  const client = new Anthropic({ apiKey: credencial })

  try {
    const resposta = await client.messages.parse({
      model,
      max_tokens: MAXIMO_DE_SAIDA,
      /* O prompt de sistema é estável por tipo de sugestão: o mesmo texto vai em
         toda chamada de "resposta sugerida". Em cache, ele custa cerca de um
         décimo. O conteúdo do chamado, que muda sempre, vai DEPOIS — ordem que o
         cache por prefixo exige. */
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: pergunta }],
      output_config: {
        effort,
        /* A amarração que torna a injeção de prompt inofensiva: a resposta não
           pode ser outra coisa senão este objeto. */
        format: zodOutputFormat(esquema),
      },
    })

    /*
     * Recusa por segurança do provedor vem como HTTP 200 com `stop_reason`
     * `refusal` — não como exceção. Ler `content` sem conferir isso daria um
     * objeto vazio e um erro de formato, que é a mensagem errada para a tela.
     */
    if (resposta.stop_reason === 'refusal') {
      return {
        ok: false,
        falha: {
          tipo: 'recusa',
          mensagem:
            'O provedor recusou a solicitação por política de conteúdo. O texto do chamado pode conter algo que ele interpretou assim.',
        },
      }
    }

    if (resposta.stop_reason === 'max_tokens') {
      // Resposta cortada no meio: o JSON não fecha, e o `parsed_output` é nulo.
      // Dizer "formato inválido" esconderia a causa, que tem conserta.
      return {
        ok: false,
        falha: {
          tipo: 'limite',
          mensagem: 'A resposta passou do tamanho máximo. Tente num chamado com menos histórico.',
        },
      }
    }

    if (!resposta.parsed_output) {
      return {
        ok: false,
        falha: {
          tipo: 'formato',
          mensagem: 'A resposta do provedor não veio no formato esperado.',
        },
      }
    }

    const entrada =
      resposta.usage.input_tokens +
      (resposta.usage.cache_creation_input_tokens ?? 0) +
      (resposta.usage.cache_read_input_tokens ?? 0)
    const saida = resposta.usage.output_tokens

    return {
      ok: true,
      resultado: {
        dados: resposta.parsed_output,
        /* O modelo que REALMENTE respondeu, não o que foi pedido: o provedor pode
           ter servido outro, e o custo é o do que respondeu. */
        model: resposta.model,
        tokens_entrada: entrada,
        tokens_saida: saida,
        custo_centavos: custoEmCentavos(resposta.model, entrada, saida),
      },
    }
  } catch (erro) {
    /* Cadeia do mais específico ao mais geral: as três primeiras têm conserto
       diferente, e "erro de API" para todas mandaria a pessoa para o lugar
       errado. */
    if (erro instanceof Anthropic.AuthenticationError) {
      return {
        ok: false,
        falha: {
          tipo: 'credencial',
          mensagem: 'A chave configurada foi recusada pelo provedor.',
        },
      }
    }
    if (erro instanceof Anthropic.RateLimitError) {
      return {
        ok: false,
        falha: {
          tipo: 'limite',
          mensagem: 'O provedor está limitando as chamadas agora. Tente de novo em alguns minutos.',
        },
      }
    }
    if (erro instanceof Anthropic.APIError) {
      console.error('[ia] provedor:', erro.status, erro.message)
      return {
        ok: false,
        falha: { tipo: 'provedor', mensagem: `O provedor respondeu com erro ${erro.status}.` },
      }
    }
    console.error('[ia] falha inesperada:', erro)
    return {
      ok: false,
      falha: { tipo: 'provedor', mensagem: 'Não foi possível falar com o provedor.' },
    }
  }
}
