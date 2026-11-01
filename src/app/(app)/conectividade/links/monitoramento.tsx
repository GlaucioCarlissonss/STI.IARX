'use client'

import { useActionState, useSyncExternalStore } from 'react'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import {
  criarEntradaDeMonitoramento,
  desligarEntradaDeMonitoramento,
} from './actions'

export interface EntradaDeMonitoramento {
  id: string
  name: string
  active: boolean
  last_seen_at: string | null
  created_at: string
}

/**
 * A entrada de monitoramento, na tela de quem cuida dos links.
 *
 * ## Por que aqui, e não em Integrações
 *
 * Porque o que ela liga é a disponibilidade DESTE cadastro. Quem configura o
 * Zabbix precisa, na mesma tela, do `monitoring_host` do link — e esse campo
 * está no formulário ao lado. Em Integrações, a pessoa teria que ir e voltar
 * para conferir cada host.
 *
 * ## O endereço aparece uma vez
 *
 * O banco guarda só o SHA-256. Não é zelo decorativo: um token em claro numa
 * linha de tabela aparece em backup, em export de suporte e na tela de quem tem
 * `select`. Se a pessoa perder, cria outra entrada e desliga a antiga — que é
 * por isso que desligar não apaga.
 *
 * ## "Último alerta recebido" é a coluna que responde a primeira pergunta
 *
 * Quando nada acontece, a dúvida é sempre a mesma: o link está bom ou o Zabbix
 * não está falando? Sem esta coluna, as duas situações têm exatamente o mesmo
 * sintoma — uma tela parada.
 */
export function MonitoramentoCard({
  entradas,
  origem,
}: {
  entradas: EntradaDeMonitoramento[]
  /** Base da URL, do servidor: o `window.location` não existe na primeira pintura. */
  origem: string
}) {
  const [estado, acao, pendente] = useActionState(criarEntradaDeMonitoramento, {})

  /*
   * O botão espera a hidratação, e aqui isso não é zelo: o token aparece UMA
   * vez, no retorno da ação. Clicar antes de o React assumir o formulário envia
   * o POST nativo, a entrada é criada no banco — e o endereço não aparece na
   * tela. A pessoa fica com uma entrada que existe e um token que ninguém mais
   * consegue ler, e o único remédio é criar outra.
   *
   * A janela é de frações de segundo, e foi reproduzida: a suíte de navegador
   * clicava rápido demais e perdia o token em toda rodada.
   *
   * `useSyncExternalStore` em vez de `useState` com efeito: o instantâneo do
   * servidor é `false` e o do cliente é `true`, então a troca acontece na
   * hidratação, sem efeito e sem divergência — o mesmo motivo de `nav-group.tsx`.
   */
  const hidratado = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--color-ink-2)]">
        O Zabbix avisa aqui quando um link cai e quando volta — com o horário da
        queda, não o da digitação. Cada entrada tem um endereço próprio; cole-o no
        script de mídia do Zabbix. O link é encontrado pelo campo{' '}
        <strong>Host de monitoramento</strong> do cadastro.
      </p>

      {estado.token && (
        <div className="rounded-lg border border-[var(--color-ok-ink)] bg-[var(--color-ok-soft)] p-3">
          <p className="text-sm font-semibold text-[var(--color-ok-ink)]">
            Copie agora — este endereço não volta a aparecer.
          </p>
          <code className="mt-2 block overflow-x-auto rounded bg-[var(--color-surface)] px-2 py-1 font-mono text-xs">
            {origem}/api/monitoramento/{estado.token}
          </code>
        </div>
      )}

      {entradas.length > 0 && (
        <ul className="flex flex-col gap-2">
          {entradas.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{e.name}</p>
                <p className="text-xs text-[var(--color-ink-3)]">
                  {e.active ? 'ativa' : 'desligada'} ·{' '}
                  {e.last_seen_at
                    ? `último alerta em ${new Date(e.last_seen_at).toLocaleString('pt-BR')}`
                    : 'nenhum alerta recebido ainda'}
                </p>
              </div>
              {e.active && (
                <ActionForm action={desligarEntradaDeMonitoramento}>
                  <input type="hidden" name="id" value={e.id} />
                  <SubmitButton variant="secondary">Desligar</SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}

      <form action={acao} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[14rem] flex-1">
          <Field label="Nome da entrada" htmlFor="monitoramento-nome">
          <input
            id="monitoramento-nome"
            name="name"
            required
            maxLength={120}
            placeholder="Zabbix da matriz"
            className={inputClass}
          />
          </Field>
        </div>
        <button
          type="submit"
          disabled={pendente || !hidratado}
          className="rounded-lg bg-[var(--color-brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pendente ? 'Criando…' : 'Criar entrada'}
        </button>
      </form>

      {estado.error && (
        <p role="alert" className="text-sm text-[var(--color-breach-ink)]">
          {estado.error}
        </p>
      )}
    </div>
  )
}
