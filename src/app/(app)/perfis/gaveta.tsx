import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { roleLabel } from '@/lib/i18n'
import type { AccessProfile } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { EditProfileForm, NewProfileForm, PermissionMatrix } from './profile-forms'

/**
 * O perfil de acesso na gaveta.
 *
 * ## Por que a matriz vem primeiro
 *
 * Porque é o que a pessoa veio fazer. Nome, descrição e papel base se escrevem
 * uma vez; a matriz módulo → tela → ação é revisitada toda vez que alguém muda
 * de função. Na tela antiga os dois ficavam atrás de painéis irmãos — "Permissões"
 * e "Editar" lado a lado —, o que dava a entender que são o mesmo tipo de
 * trabalho.
 *
 * ## Por que ela cabe em 34rem
 *
 * Cada módulo é um `<details>` fechado, e só abre o que já tem concessão. Um
 * perfil de atendente chega com três módulos abertos, não com os dezesseis.
 * Largura não era o problema da matriz — era ela dividir a tela com a lista de
 * perfis e com a coluna de cadastro ao mesmo tempo.
 */
export async function GavetaDePerfil({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeEditar, podeCriar] = await Promise.all([
    allowed('usuarios.perfis.editar'),
    allowed('usuarios.perfis.criar'),
  ])

  if (novo) {
    if (!podeCriar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Novo perfil de acesso">
        <CabecalhoDaGaveta
          titulo="Novo perfil"
          linha="Papel base + matriz de permissões"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <p className="text-sm text-[var(--color-ink-2)]">
            O perfil nasce sem nenhuma permissão marcada. Depois de criar, abra-o para montar a
            matriz — assim ninguém recebe acesso por engano entre um passo e outro.
          </p>
          <NewProfileForm />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const supabase = await createClient()
  const { data: perfil } = await supabase
    .from('access_profiles')
    .select('id, name, description, base_role, is_system, system_key, is_active')
    .eq('id', id)
    .maybeSingle<AccessProfile>()

  if (!perfil) return null

  const [{ data: grants }, { count: usuarios }] = await Promise.all([
    supabase.from('permission_grants').select('permission_key').eq('profile_id', perfil.id),
    supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('access_profile_id', perfil.id),
  ])

  const concedidas = (grants ?? []).map((g) => g.permission_key)
  const acoes = concedidas.filter((k) => k.split('.').length === 3).length
  const emUso = usuarios ?? 0

  return (
    <Gaveta fechar={fechar} rotulo={perfil.name}>
      <CabecalhoDaGaveta
        titulo={perfil.name}
        linha={`Teto ${roleLabel[perfil.base_role]} · ${acoes} ação(ões) · ${
          emUso > 0 ? `${emUso} usuário(s)` : 'nenhum usuário'
        }`}
        fechar={fechar}
        selo={
          <>
            {perfil.is_system && <Badge tone="info">Sistema</Badge>}
            {perfil.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
          </>
        }
      />

      <CorpoDaGaveta>
        {perfil.description && (
          <p className="text-sm text-[var(--color-ink-2)]">{perfil.description}</p>
        )}

        {podeEditar ? (
          <>
            <PermissionMatrix profile={perfil} granted={concedidas} />

            <section className="border-t border-[var(--color-border)] pt-4">
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
                Dados do perfil
              </h3>
              <EditProfileForm profile={perfil} />
            </section>
          </>
        ) : (
          <p className="text-sm italic text-[var(--color-ink-3)]">
            Somente leitura: alterar perfis exige a permissão de editar.
          </p>
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
