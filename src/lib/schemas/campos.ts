import { z } from 'zod'

/**
 * Coerções reutilizadas pelas Server Actions.
 *
 * Todo campo de `FormData` chega como string — inclusive os vazios. Estes
 * helpers convertem "" em `null` de forma consistente, para que o banco receba
 * NULL em vez de string vazia (que passaria despercebida em constraints e
 * apareceria como campo "preenchido com nada" nos relatórios).
 */

/**
 * `""` e AUSENTE → `null`; qualquer outro texto passa aparado.
 *
 * ## Por que `null` entra junto com `""`
 *
 * Porque `formData.get('campo')` devolve `null` quando o campo **não existe no
 * formulário** — e isso é comum e legítimo: o `<input name="id">` só aparece na
 * edição, não no cadastro; `parent_task_id` só aparece na subtarefa.
 *
 * Sem aceitar `null`, o Zod recusa com *"expected string, received null"* — uma
 * mensagem que fala do tipo e não do campo, numa tela onde a pessoa não deixou
 * nada em branco. Foi assim que o formulário de **cadastro de serviço** passou
 * de uma onda inteira sem nunca ter criado um serviço: ele não tem campo `id`,
 * e a validação morria antes de chegar ao banco.
 *
 * Ausente e vazio querem dizer a mesma coisa para um valor opcional. Tratá-los
 * diferente só criava uma armadilha para quem escrevesse o próximo formulário.
 */
export const emptyToNull = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const texto = (v ?? '').trim()
    return texto === '' ? null : texto
  })

/**
 * Um UUID obrigatório vindo de `<select>` ou de campo oculto.
 *
 * A mensagem é a mesma em toda a aplicação de propósito. Ela estava escrita à
 * mão em **onze lugares**, e já divergia: "Seleção inválida." em umas,
 * nada em outras, que faz o Zod devolver a mensagem padrão em inglês —
 * `Invalid uuid` na cara de quem só errou o formulário.
 *
 * O texto não diz "UUID" porque quem lê não escolheu um UUID: escolheu um item
 * numa lista. Um identificador malformado chegando aqui é defeito de formulário
 * ou de adulteração, e nos dois casos a frase útil é a mesma.
 */
export const uuid = z.string().uuid('Seleção inválida.')

/** `""` → `null`; caso contrário exige UUID válido. */
export const optionalUuid = emptyToNull.pipe(z.union([uuid, z.null()]))

/**
 * `""` → `null`; caso contrário número não negativo.
 * Feito com transform + refine em vez de `z.coerce.number()`: o coerce aceita
 * entrada `unknown` e não encadeia com o transform anterior sob type-check.
 */
export const optionalNonNegativeNumber = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : Number(v)))
  .refine((v) => v === null || (Number.isFinite(v) && v >= 0), {
    message: 'Informe um número válido, maior ou igual a zero.',
  })

/** Igual ao anterior, mas limitado a um intervalo (usado na avaliação 0–5). */
export function optionalNumberInRange(min: number, max: number) {
  return z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : Number(v)))
    .refine((v) => v === null || (Number.isFinite(v) && v >= min && v <= max), {
      message: `Informe um número entre ${min} e ${max}.`,
    })
}

/** Obrigatório, inteiro, dentro do intervalo — peso de prioridade, ordem de exibição, minutos de SLA. */
export function intInRange(min: number, max: number) {
  return z
    .string()
    .trim()
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v >= min && v <= max, {
      message: `Informe um número inteiro entre ${min} e ${max}.`,
    })
}

/** `""` → `null`; caso contrário inteiro positivo (SLA contratado, em minutos). */
export const optionalPositiveInt = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : Number(v)))
  .refine((v) => v === null || (Number.isInteger(v) && v > 0), {
    message: 'Informe um número inteiro maior que zero.',
  })
