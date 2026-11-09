import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatCnpj, formatCurrency, formatDate, formatMinutes } from '@/lib/format'
import type { Supplier, SupplierContract } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { EditPanel } from '@/components/edit-panel'
import { EditSupplierForm, NewSupplierForm } from './supplier-forms'
import { EditSupplierContractForm, NewSupplierContractForm } from './supplier-contract-forms'

/**
 * O fornecedor na gaveta — com os contratos dele dentro.
 *
 * ## O `EditPanel` que ficou
 *
 * Aqui dentro ele continua, e isso é deliberado: o idioma que a Fase 5 elimina
 * é "abrir um REGISTRO num painel embaixo da linha". Um painel que abre uma
 * SEÇÃO dentro da gaveta — editar um dos contratos do fornecedor que já está
 * aberto — não compete com a gaveta, faz parte dela. É o mesmo caso de
 * "Transferir custódia" no inventário.
 *
 * ## Por que o contrato não tem gaveta própria
 *
 * Porque contrato não se lê sozinho: ele só faz sentido ao lado do fornecedor,
 * da vigência e dos outros contratos do mesmo prestador. Dar endereço próprio
 * a ele seria criar um registro de primeira classe que ninguém procura pelo
 * nome.
 */
export async function GavetaDeFornecedor({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeEditar, podeCriar, podeVerContrato, podeEditarContrato, podeCriarContrato] =
    await Promise.all([
      allowed('fornecedores.cadastro.editar'),
      allowed('fornecedores.cadastro.criar'),
      allowed('fornecedores.contratos.ver'),
      allowed('fornecedores.contratos.editar'),
      allowed('fornecedores.contratos.criar'),
    ])

  if (novo) {
    if (!podeCriar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Novo fornecedor">
        <CabecalhoDaGaveta
          titulo="Novo fornecedor"
          linha="Cadastro de prestador de serviço"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <NewSupplierForm />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const supabase = await createClient()
  const { data: fornecedor } = await supabase
    .from('suppliers')
    .select(
      'id, name, legal_name, cnpj, email, phone, services, rating, notes, is_active',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<Supplier>()

  if (!fornecedor) return null

  /* Contratos só para quem tem a chave: `fornecedores.contratos.ver` governa a
     seção inteira, e sem ela nem a consulta sai. */
  const { data: contratos } = podeVerContrato
    ? await supabase
        .from('supplier_contracts')
        .select(
          'id, supplier_id, contract_number, description, starts_on, ends_on, monthly_cost, response_sla_minutes, resolution_sla_minutes, is_active, notes',
        )
        .eq('supplier_id', id)
        .is('deleted_at', null)
        .order('starts_on', { ascending: false })
        .returns<SupplierContract[]>()
    : { data: null }

  return (
    <Gaveta fechar={fechar} rotulo={fornecedor.name}>
      <CabecalhoDaGaveta
        titulo={fornecedor.name}
        linha={`${fornecedor.legal_name ?? '—'} · ${formatCnpj(fornecedor.cnpj)}`}
        fechar={fechar}
        selo={fornecedor.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
      />

      <CorpoDaGaveta>
        <p className="text-sm text-[var(--color-ink-2)]">
          {[fornecedor.email, fornecedor.phone].filter(Boolean).join(' · ') ||
            'Sem contato cadastrado'}
        </p>

        {fornecedor.services.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {fornecedor.services.map((svc) => (
              <Badge key={svc}>{svc}</Badge>
            ))}
          </div>
        )}

        {podeEditar && <EditSupplierForm supplier={fornecedor} />}

        {podeVerContrato && (
          <section className="border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
              Contratos {(contratos ?? []).length > 0 && `(${(contratos ?? []).length})`}
            </h3>

            {(contratos ?? []).length === 0 && (
              <p className="mb-3 text-sm italic text-[var(--color-ink-3)]">
                Nenhum contrato registrado para este fornecedor.
              </p>
            )}

            <div className="flex flex-col gap-2">
              {(contratos ?? []).map((c) => (
                <div
                  key={c.id}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-[var(--color-ink)]">
                      {c.contract_number ?? 'sem número'}
                    </span>
                    {c.is_active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}
                  </div>
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {formatDate(c.starts_on)} →{' '}
                    {c.ends_on ? formatDate(c.ends_on) : 'indeterminado'} ·{' '}
                    {formatCurrency(c.monthly_cost)}/mês
                  </p>
                  <p className="text-xs text-[var(--color-ink-3)]">
                    SLA {formatMinutes(c.response_sla_minutes)} para responder,{' '}
                    {formatMinutes(c.resolution_sla_minutes)} para resolver
                  </p>
                  {podeEditarContrato && (
                    <div className="mt-2">
                      <EditPanel title={`Editar contrato ${c.contract_number ?? ''}`}>
                        <EditSupplierContractForm contract={c} />
                      </EditPanel>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {podeCriarContrato && (
              <div className="mt-3">
                <EditPanel label="+ Novo contrato">
                  <NewSupplierContractForm supplierId={fornecedor.id} />
                </EditPanel>
              </div>
            )}
          </section>
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
