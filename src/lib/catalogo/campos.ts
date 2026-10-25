import { z } from 'zod'

/**
 * Os campos que um serviço do catálogo pede a quem solicita.
 *
 * ## Por que `jsonb` e não tabelas
 *
 * Um formulário por serviço, com três campos em média. Modelado em tabelas daria
 * `service_fields` + `service_field_options` + `ticket_field_values` — três
 * tabelas e seis junções para renderizar um formulário que ninguém consulta de
 * forma atravessada ("quais pedidos tiveram o campo X igual a Y?" não é uma
 * pergunta que este produto faz).
 *
 * O preço do `jsonb` é não poder consultar por campo. É um preço que este caso
 * não paga — e, no dia em que pagar, a migração é de uma tabela só, porque o
 * conteúdo já está estruturado.
 *
 * ## Os quatro tipos, e por que não mais
 *
 * Texto, número, escolha e sim/não cobrem o que um catálogo de TI pede: um
 * patrimônio, uma quantidade, um modelo de uma lista, um "precisa de urgência?".
 * Data e arquivo foram deixados de fora de propósito — data exigiria fuso e
 * validação de passado, arquivo exigiria o Storage e a cota, e os dois
 * apareceriam como campo quebrado antes de aparecerem como recurso.
 */
export const campoSchema = z.object({
  chave: z
    .string()
    .trim()
    .min(1)
    .max(40)
    /* A chave vira nome de campo no formulário e chave no `jsonb` do chamado.
       Restrita a letras, números e sublinhado porque ela atravessa HTML e JSON,
       e um espaço ou acento ali produz um bug que só aparece na submissão. */
    .regex(/^[a-z][a-z0-9_]*$/, 'Use só letras minúsculas, números e sublinhado.'),
  rotulo: z.string().trim().min(1).max(120),
  tipo: z.enum(['texto', 'numero', 'escolha', 'simnao']),
  obrigatorio: z.boolean().default(false),
  ajuda: z.string().trim().max(200).optional(),
  opcoes: z.array(z.string().trim().min(1).max(120)).max(40).optional(),
})

export const camposSchema = z.array(campoSchema).max(20)

export type Campo = z.infer<typeof campoSchema>

/** Lê os campos de um serviço, tolerando o que não bate com o schema. */
export function lerCampos(bruto: unknown): Campo[] {
  const r = camposSchema.safeParse(bruto)
  /*
   * Campo malformado é DESCARTADO, e o resto do formulário continua de pé.
   *
   * O conteúdo veio de um administrador editando JSON; recusar o serviço inteiro
   * por causa de um campo com erro de digitação esconderia o serviço da vitrine —
   * e quem o cadastrou não teria como saber por quê, porque a vitrine não é a
   * tela de cadastro.
   */
  if (r.success) return r.data
  if (!Array.isArray(bruto)) return []
  return bruto.flatMap((c) => {
    const um = campoSchema.safeParse(c)
    return um.success ? [um.data] : []
  })
}

/**
 * Valida o que a pessoa preencheu contra a definição do serviço.
 *
 * Devolve `{ok, valores}` ou `{ok: false, erro}`. O erro é uma frase para a tela,
 * e nomeia o CAMPO pelo rótulo — não pela chave: quem preenche viu "Patrimônio
 * do equipamento", não `patrimonio`.
 */
export function validarPreenchimento(
  campos: Campo[],
  lido: (chave: string) => string | null,
): { ok: true; valores: Record<string, string | number | boolean> } | { ok: false; erro: string } {
  const valores: Record<string, string | number | boolean> = {}

  for (const campo of campos) {
    const bruto = (lido(campo.chave) ?? '').trim()

    if (bruto === '') {
      if (campo.obrigatorio && campo.tipo !== 'simnao') {
        return { ok: false, erro: `Preencha "${campo.rotulo}".` }
      }
      if (campo.tipo === 'simnao') valores[campo.chave] = false
      continue
    }

    switch (campo.tipo) {
      case 'numero': {
        const n = Number(bruto.replace(',', '.'))
        if (!Number.isFinite(n)) {
          return { ok: false, erro: `"${campo.rotulo}" precisa ser um número.` }
        }
        valores[campo.chave] = n
        break
      }
      case 'escolha': {
        // A lista de opções é a definição do serviço; aceitar fora dela deixaria
        // o pedido com um valor que a operação não sabe atender.
        if (campo.opcoes && !campo.opcoes.includes(bruto)) {
          return { ok: false, erro: `Escolha uma das opções de "${campo.rotulo}".` }
        }
        valores[campo.chave] = bruto
        break
      }
      case 'simnao':
        valores[campo.chave] = bruto === 'on' || bruto === 'true' || bruto === 'sim'
        break
      default:
        if (bruto.length > 2000) {
          return { ok: false, erro: `"${campo.rotulo}" está longo demais.` }
        }
        valores[campo.chave] = bruto
    }
  }

  return { ok: true, valores }
}

/** O preço, em reais, como a vitrine o escreve. */
export function precoEmTexto(
  preco: number | null,
  incluso: boolean,
  unidade: string | null,
): string {
  /*
   * As três frases são diferentes de propósito, e a diferença importa:
   *
   *   · "Incluído no contrato" — o cliente já paga por isto no pacote.
   *   · "Sem custo"            — é de graça para todo mundo.
   *   · "Sob consulta"         — não há preço publicado; combina-se caso a caso.
   *
   * Tratar nulo como zero faria o terceiro caso aparecer como cortesia, e a
   * primeira cobrança seria uma discussão.
   */
  if (incluso) return 'Incluído no contrato'
  if (preco === null) return 'Sob consulta'
  if (preco === 0) return 'Sem custo'

  const valor = preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const porUnidade: Record<string, string> = {
    hora: ' por hora',
    mes: ' por mês',
    ponto: ' por ponto',
    usuario: ' por usuário',
    unidade: '',
  }
  return valor + (unidade ? (porUnidade[unidade] ?? '') : '')
}
