import { z } from 'zod'

/**
 * Regras de senha e e-mail, num lugar só.
 *
 * Estavam inline em `src/app/(app)/conta/actions.ts`, e com o fluxo de
 * recuperação passaram a existir em dois lugares — que é exatamente onde
 * divergem: quem aperta o mínimo numa tela esquece a outra, e a senha fraca
 * entra pela porta que ninguém revisou.
 */

/** Mínimo do Supabase Auth é 6; 8 é a escolha desta base e vale nos dois fluxos. */
export const newPasswordSchema = z
  .object({
    password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'As senhas não coincidem.',
    path: ['confirm'],
  })

export const recoveryEmailSchema = z.object({
  email: z.string().trim().email('Informe um e-mail válido.'),
})
