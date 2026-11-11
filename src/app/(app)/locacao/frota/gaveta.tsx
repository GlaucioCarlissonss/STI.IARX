import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'
import type {
  EquipmentCategory,
  EquipmentManufacturer,
  EquipmentModel,
  EquipmentMovement,
  RentalDepot,
  RentalEquipment,
} from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import {
  descreverMovimento,
  ESTADO_DO_EQUIPAMENTO,
  formatarMedidor,
  MEDIDOR,
} from '@/lib/locacao/rotulos'
import { EquipamentoForm, LeituraForm, MoverEstadoForm, BloqueioForm } from './forms'

/**
 * O equipamento na gaveta.
 *
 * ## Por que as transições vêm do BANCO, e não de uma lista aqui
 *
 * Porque a autoridade é o gatilho. A tela consulta
 * `rental_equipment_status_transitions` e desenha um botão por linha que casa
 * com o estado atual — então um botão que o banco recusaria não chega a ser
 * desenhado. Escrever a lista aqui criaria uma segunda verdade sobre o ciclo
 * de vida, e a divergência apareceria como erro depois do clique, que é o
 * lugar mais caro possível.
 *
 * ## Por que bloqueio tem seção própria
 *
 * Porque ele não é um estado, é um atributo que convive com qualquer estado —
 * inclusive com `locado`. Pô-lo entre os botões de transição diria com a forma
 * o contrário do que o modelo diz.
 */
export async function GavetaDeEquipamento({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeCriar, podeEditar, podeMover] = await Promise.all([
    allowed('locacao.frota.criar'),
    allowed('locacao.frota.editar'),
    allowed('locacao.frota.mover'),
  ])

  const supabase = await createClient()

  /* Os lookups da ficha são os mesmos nos dois modos — e o formulário não abre
     sem eles: equipamento sem modelo não existe. */
  const [{ data: modelos }, { data: depositos }] = await Promise.all([
    supabase
      .from('equipment_models')
      .select('id, manufacturer_id, category_id, code, name, specs, monthly_price, daily_price, is_active')
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('name')
      .returns<EquipmentModel[]>(),
    supabase
      .from('rental_depots')
      .select('id, name, code, kind, city, state, is_active')
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('name')
      .returns<RentalDepot[]>(),
  ])

  if (novo) {
    if (!podeCriar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Novo equipamento">
        <CabecalhoDaGaveta
          titulo="Novo equipamento"
          linha="Entra na frota como disponível"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          {(modelos ?? []).length === 0 ? (
            <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
              Nenhum modelo cadastrado ainda. O equipamento é uma peça <em>de um modelo</em> — é o
              modelo que carrega fabricante, categoria e preço de tabela. Cadastre um em{' '}
              <strong>Modelos e categorias</strong> antes.
            </p>
          ) : (
            <EquipamentoForm modelos={modelos ?? []} depositos={depositos ?? []} />
          )}
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: equipamento } = await supabase
    .from('rental_equipment')
    .select(
      'id, asset_tag, serial_number, model_id, depot_id, status, blocked, block_reason, block_until, meter_kind, meter_reading, meter_read_at, acquisition_date, acquisition_value, invoice_ref, useful_life_months, notes',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<RentalEquipment>()

  if (!equipamento) return null

  const modelo = (modelos ?? []).find((m) => m.id === equipamento.model_id)

  const [{ data: transicoes }, { data: movimentos }, { data: categorias }, { data: fabricantes }] =
    await Promise.all([
      supabase
        .from('rental_equipment_status_transitions')
        .select('from_status, to_status, description')
        .eq('from_status', equipamento.status)
        .returns<{ from_status: string; to_status: string; description: string | null }[]>(),
      supabase
        .from('rental_equipment_movements')
        .select(
          'id, equipment_id, kind, from_status, to_status, from_depot_id, to_depot_id, meter_reading, notes, created_by, created_at',
        )
        .eq('equipment_id', id)
        .order('created_at', { ascending: false })
        .limit(20)
        .returns<EquipmentMovement[]>(),
      supabase
        .from('equipment_categories')
        .select('id, code, name, default_meter_kind, default_useful_life_months, is_active')
        .is('deleted_at', null)
        .returns<EquipmentCategory[]>(),
      supabase
        .from('equipment_manufacturers')
        .select('id, name, support_contact, notes, is_active')
        .is('deleted_at', null)
        .returns<EquipmentManufacturer[]>(),
    ])

  const categoria = (categorias ?? []).find((c) => c.id === modelo?.category_id)
  const fabricante = (fabricantes ?? []).find((f) => f.id === modelo?.manufacturer_id)
  const deposito = (depositos ?? []).find((d) => d.id === equipamento.depot_id)
  const estado = ESTADO_DO_EQUIPAMENTO[equipamento.status]

  /*
   * Bloqueio, extravio e baixa não estão na tabela de transições de propósito —
   * são fatos alcançáveis de qualquer estado, e o gatilho sabe disso. A tela
   * acrescenta os dois que são decisão de quem opera; "bloqueado" fica de fora
   * porque aqui ele é atributo, com seção própria logo abaixo.
   */
  const destinos = [
    ...(transicoes ?? []).map((t) => ({ status: t.to_status, rotulo: t.description })),
    ...(equipamento.status === 'lost' || equipamento.status === 'written_off'
      ? []
      : [
          { status: 'lost', rotulo: 'Sumiu — registra a perda' },
          { status: 'written_off', rotulo: 'Sai do patrimônio' },
        ]),
  ]

  return (
    <Gaveta fechar={fechar} rotulo={`${equipamento.asset_tag} — ${modelo?.name ?? 'equipamento'}`}>
      <CabecalhoDaGaveta
        titulo={modelo?.name ?? equipamento.asset_tag}
        linha={`${equipamento.asset_tag}${
          equipamento.serial_number ? ` · nº de série ${equipamento.serial_number}` : ''
        }${categoria ? ` · ${categoria.name}` : ''}`}
        fechar={fechar}
        selo={
          <>
            <Badge tone={estado.tone}>{estado.label}</Badge>
            {equipamento.blocked && <Badge tone="crit">bloqueado</Badge>}
          </>
        }
      />

      <CorpoDaGaveta>
        <section>
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Onde está</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-ink-3)]">Depósito</dt>
            <dd className="text-right font-medium">{deposito?.name ?? 'sem depósito'}</dd>
            <dt className="text-[var(--color-ink-3)]">Fabricante</dt>
            <dd className="text-right font-medium">{fabricante?.name ?? '—'}</dd>
            <dt className="text-[var(--color-ink-3)]">{MEDIDOR[equipamento.meter_kind].label}</dt>
            <dd className="text-right font-medium tabular-nums">
              {formatarMedidor(equipamento.meter_kind, equipamento.meter_reading)}
              {equipamento.meter_read_at && (
                <span className="ml-1 text-xs font-normal text-[var(--color-ink-3)]">
                  em {formatDate(equipamento.meter_read_at)}
                </span>
              )}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Aquisição</dt>
            <dd className="text-right font-medium">
              {equipamento.acquisition_date ? formatDate(equipamento.acquisition_date) : '—'}
              {equipamento.acquisition_value !== null && (
                <span className="ml-1 text-xs font-normal text-[var(--color-ink-3)]">
                  {formatCurrency(equipamento.acquisition_value)}
                </span>
              )}
            </dd>
          </dl>
        </section>

        {podeMover && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Mudar de estado</h3>
            {destinos.length === 0 ? (
              <p className="text-sm italic text-[var(--color-ink-3)]">
                Deste estado não sai nenhuma transição: é um fim de linha.
              </p>
            ) : (
              <MoverEstadoForm id={equipamento.id} destinos={destinos} />
            )}
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              Só aparecem as transições que o banco aceita a partir de{' '}
              <strong>{estado.label}</strong>. A lista vem da tabela de transições, não desta tela.
            </p>
          </section>
        )}

        {podeMover && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
              Bloqueio {equipamento.blocked && <Badge tone="crit">ativo</Badge>}
            </h3>
            <p className="mb-2 text-xs text-[var(--color-ink-3)]">
              O bloqueio impede nova alocação <em>sem</em> tirar a máquina de operação. Uma peça
              locada com preventiva vencida continua locada — e, ao voltar, não entra na base
              alocável.
            </p>
            <BloqueioForm equipamento={equipamento} />
          </section>
        )}

        {podeMover && equipamento.meter_kind !== 'none' && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
              Registrar leitura
            </h3>
            <LeituraForm equipamento={equipamento} />
          </section>
        )}

        <section className="border-t border-[var(--color-border)] pt-4">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
            Histórico {(movimentos ?? []).length > 0 && `(${(movimentos ?? []).length})`}
          </h3>
          {(movimentos ?? []).length === 0 ? (
            <p className="text-sm italic text-[var(--color-ink-3)]">Nada registrado ainda.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {(movimentos ?? []).map((m) => (
                <li key={m.id} className="rounded-lg border border-[var(--color-border)] px-3 py-2">
                  <p className="text-sm text-[var(--color-ink)]">{descreverMovimento(m)}</p>
                  <p className="text-xs text-[var(--color-ink-3)]">{formatDateTime(m.created_at)}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-[var(--color-ink-3)]">
            Escrito pelo banco, não pela tela: continua registrando quando alguém mexe por SQL
            direto, que é quando o histórico mais importa.
          </p>
        </section>

        {podeEditar && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Ficha</h3>
            <EquipamentoForm
              equipamento={equipamento}
              modelos={modelos ?? []}
              depositos={depositos ?? []}
            />
          </section>
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
