import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { formatDateTime } from '@/lib/format'
import { Badge, Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from '@/components/ui'

export const metadata: Metadata = { title: 'Software instalado' }

interface LinhaDeSoftware {
  name: string
  publisher: string | null
  maquinas: number
  versoes: number
  visto_por_ultimo: string
  maquinas_atuais: number
}

/**
 * O software da frota, visto de cima.
 *
 * ## Por que esta tela é separada da ficha da máquina
 *
 * A pergunta é atravessada. A ficha da máquina responde "o que tem neste
 * computador?"; esta responde "em quantos computadores tem isto?" — e as duas
 * perguntas são feitas por pessoas diferentes, em momentos diferentes. Quem faz
 * gestão de licença não quer abrir 200 fichas para contar.
 *
 * ## As três perguntas que ela responde
 *
 * **"Quem ainda tem o sistema antigo?"** — a mais valiosa, e a que motiva o
 * recurso. Digitar "Windows 10" na busca e ver 40 máquinas é a diferença entre
 * um projeto de migração com escopo e um chute.
 *
 * **"Quantas licenças estamos usando de verdade?"** — a contagem de máquinas por
 * programa, que quase nunca bate com o que foi comprado.
 *
 * **"Quem desinstalou o antivírus?"** — a coluna `maquinas_atuais` ao lado de
 * `maquinas`: a diferença entre as duas é quem tinha e não tem mais. É pergunta
 * de segurança, não de inventário, e é a razão de o software desinstalado nunca
 * ser apagado.
 *
 * ## O que ela NÃO faz
 *
 * Não cruza com base de CVE. Casar software instalado com vulnerabilidade
 * conhecida é outro produto — exige uma base que envelhece todo dia e um
 * normalizador de nome de pacote que é um projeto em si. O caminho é faseado, e
 * o inventário de software sozinho já responde as três perguntas acima.
 */
export default async function SoftwarePage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string; busca?: string }>
}) {
  const params = await searchParams
  await requireScreen('inventario.software.ver')

  const supabase = await createClient()
  const pagina = lerPagina(params.pagina)
  const busca = (params.busca ?? '').trim()

  let consulta = supabase
    .from('vw_agent_software')
    .select('name, publisher, maquinas, versoes, visto_por_ultimo, maquinas_atuais', {
      count: 'exact',
    })
  if (busca) {
    /* `ilike` e não busca textual: o nome de um programa não é prosa, e quem
       procura digita um pedaço do nome ("chrome", "office", "Windows 10"). Uma
       busca textual tokenizaria e deixaria de casar "Windows 10" com
       "Microsoft Windows 10 Pro". */
    consulta = consulta.ilike('name', `%${busca.replace(/[%_]/g, '\\$&')}%`)
  }

  const [{ data: linhas, count }, { data: universo }] = await Promise.all([
    paginar(consulta.order('maquinas', { ascending: false }), pagina).returns<LinhaDeSoftware[]>(),
    /* Os indicadores leem o acervo inteiro, e não a página — mesma lição da
       entrega 6. Duas colunas, que é um payload pequeno mesmo com milhares de
       programas distintos. */
    supabase
      .from('vw_agent_software')
      .select('maquinas, maquinas_atuais')
      .returns<{ maquinas: number; maquinas_atuais: number }[]>(),
  ])

  const todos = universo ?? []
  const sumiram = todos.filter((s) => s.maquinas_atuais < s.maquinas).length
  const emUmaSo = todos.filter((s) => s.maquinas === 1).length
  const lista = linhas ?? []

  return (
    <>
      <PageHeader
        title="Software instalado"
        description="O que está instalado na frota, contado por programa. Vem do agente — não é digitado."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile label="Programas distintos" value={todos.length} />
        <StatTile
          label="Deixaram de aparecer"
          value={sumiram}
          hint="em pelo menos uma máquina"
          tone={sumiram > 0 ? 'neutral' : 'ok'}
        />
        <StatTile
          label="Em uma máquina só"
          value={emUmaSo}
          hint="candidatos a licença ociosa"
        />
      </div>

      <form className="mb-4 flex flex-wrap gap-2" role="search">
        <label className="sr-only" htmlFor="busca">
          Procurar programa
        </label>
        <input
          id="busca"
          name="busca"
          type="search"
          defaultValue={busca}
          placeholder="Windows 10, Chrome, Office…"
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)]"
        />
        <button
          type="submit"
          className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)]"
        >
          Procurar
        </button>
      </form>

      {lista.length === 0 ? (
        <EmptyState
          title={busca ? `Nenhum programa com "${busca}"` : 'Nada coletado ainda'}
          description={
            busca
              ? 'Tente um pedaço menor do nome: a busca casa qualquer parte.'
              : 'A lista é montada a partir do que o agente coleta. Instale o agente em alguma máquina e ela aparece aqui na primeira coleta.'
          }
        />
      ) : (
        <>
          <Table
            label="Software instalado na frota"
            head={['Programa', 'Fabricante', 'Máquinas', 'Versões', 'Visto por último']}
          >
            {lista.map((s) => {
              const perdidas = s.maquinas - s.maquinas_atuais
              return (
                <tr key={s.name}>
                  <Td>{s.name}</Td>
                  <Td className="text-[var(--color-ink-2)]">{s.publisher ?? '—'}</Td>
                  <Td>
                    <span className="font-medium text-[var(--color-ink)]">{s.maquinas_atuais}</span>
                    {perdidas > 0 && (
                      <span className="ml-2 text-xs text-[var(--color-ink-3)]">
                        (saiu de {perdidas})
                      </span>
                    )}
                  </Td>
                  <Td>
                    {s.versoes > 1 ? (
                      /* Mais de uma versão na frota é o sinal de parque
                         desatualizado — e é exatamente o que se procura aqui. */
                      <Badge tone="warn">{s.versoes}</Badge>
                    ) : (
                      <span className="text-[var(--color-ink-2)]">1</span>
                    )}
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {formatDateTime(s.visto_por_ultimo)}
                  </Td>
                </tr>
              )
            })}
          </Table>
          <Pager
            pagina={pagina.numero}
            total={count ?? 0}
            tamanho={pagina.tamanho}
            base="/inventario/software"
            params={params}
          />
        </>
      )}

      <Card title="Como ler esta tela" className="mt-6">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>
            <strong>Máquinas</strong> conta onde o programa estava na última coleta. O
            &ldquo;saiu de N&rdquo; ao lado é quem tinha e desinstalou — a lista nunca é apagada,
            porque &ldquo;quem desinstalou o antivírus?&rdquo; é pergunta de segurança.
          </li>
          <li>
            <strong>Versões</strong> maior que 1 é parque desatualizado. É por aqui que se responde
            &ldquo;quem ainda tem a versão antiga?&rdquo; sem abrir máquina por máquina.
          </li>
          <li>
            Não há cruzamento com base de vulnerabilidade (CVE). Isso é outro produto, e o caminho
            é faseado: primeiro saber o que está instalado, depois casar com a base, se o mercado
            pedir.
          </li>
        </ul>
      </Card>
    </>
  )
}
