import { canManageConfig, canManageRecords, requirePermission, requireSession } from '@/lib/session'
import type { Profile } from '@/lib/types'

/**
 * A guarda que abre toda Server Action de escrita.
 *
 * O bloco abaixo estava copiado em **15 arquivos de actions**, 44 vezes:
 *
 * ```ts
 * const { profile } = await requireSession()
 * const gate = await requirePermission('x.y.z')
 * if ('error' in gate) return gate
 * if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }
 * ```
 *
 * São DUAS checagens distintas, e as duas precisam ficar: a chave granular diz
 * *o que* a pessoa pode fazer (catálogo de permissões, migração 0017), e o papel
 * diz se ela escreve *alguma coisa* — é o mesmo predicado que o RLS aplica no
 * banco (`app.can_manage_records`). Uma sem a outra deixaria passar o caso em que
 * o perfil concede a chave mas o papel efetivo é de leitura.
 *
 * O que muda aqui é só a repetição. A semântica é idêntica, inclusive a ordem:
 * a sessão primeiro (quem não está logado é redirecionado, não recebe erro), a
 * chave depois, o papel por último.
 */
export type ResultadoDaGuarda = { profile: Profile } | { error: string }

export async function permitirEscrita(
  chave: string,
  opcoes: {
    /** `'records'` é o padrão; `'config'` é o teto de admin (usuários e perfis). */
    papel?: 'records' | 'config'
    /** Mensagem quando o PAPEL barra. A da chave vem de `requirePermission`. */
    mensagem?: string
  } = {},
): Promise<ResultadoDaGuarda> {
  const { profile } = await requireSession()

  const gate = await requirePermission(chave)
  if ('error' in gate) return gate

  const permitido =
    opcoes.papel === 'config' ? canManageConfig(profile.role) : canManageRecords(profile.role)
  if (!permitido) return { error: opcoes.mensagem ?? 'Sem permissão.' }

  return { profile }
}
