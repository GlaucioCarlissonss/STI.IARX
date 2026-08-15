import { z } from 'zod'

/**
 * Coerções reutilizadas pelas Server Actions.
 *
 * Todo campo de `FormData` chega como string — inclusive os vazios. Estes
 * helpers convertem "" em `null` de forma consistente, para que o banco receba
 * NULL em vez de string vazia (que passaria despercebida em constraints e
 * apareceria como campo "preenchido com nada" nos relatórios).
 */

/** `""` → `null`; qualquer outro texto passa aparado. */
export const emptyToNull = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))

/** `""` → `null`; caso contrário exige UUID válido. */
export const optionalUuid = emptyToNull.pipe(z.union([z.string().uuid('Seleção inválida.'), z.null()]))

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
