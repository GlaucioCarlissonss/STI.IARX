'use client'

import { useActionState, useState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { ROTULO_DO_CANAL, type TipoDeCanal } from '@/lib/canais/registro'
import { ListaDeExigencias } from './exigencias'
import { salvarCanal, type CanalActionState } from '../actions'

/**
 * Modelos de `config` por tipo.
 *
 * Não é conveniência: é a diferença entre "preencha a configuração" e saber
 * **quais chaves** o adaptador lê. Sem isto, descobrir que o WhatsApp precisa de
 * `phone_number_id` exigiria ler o código do adaptador — e o sintoma de esquecer
 * é o canal receber normalmente e nunca conseguir responder.
 *
 * Os valores são nomes de variáveis de ambiente de exemplo, deliberadamente com
 * cara de nome: a ação recusa qualquer coisa em `*_ref` que não seja um
 * identificador em maiúsculas, inclusive um token colado do painel da Meta.
 */
const MODELO: Record<TipoDeCanal, string> = {
  whatsapp: JSON.stringify(
    { app_secret_ref: 'META_APP_SECRET', phone_number_id: '000000000000000' },
    null,
    2,
  ),
  email: '{}',
  bitrix24: JSON.stringify({ application_token_ref: 'BITRIX_APP_TOKEN' }, null, 2),
  n8n: JSON.stringify({ url: 'https://n8n.exemplo.com.br/webhook/sti-saida' }, null, 2),
}

const SECRET_EXEMPLO: Record<TipoDeCanal, string> = {
  whatsapp: 'WHATSAPP_TOKEN_MATRIZ',
  email: '',
  bitrix24: 'BITRIX_WEBHOOK_ENTRADA',
  n8n: 'N8N_URL_DE_SAIDA',
}

export function CanalForm({
  filas,
  prioridades,
  clientes,
}: {
  filas: { id: string; name: string }[]
  prioridades: { id: string; name: string }[]
  clientes: { id: string; nome: string }[]
}) {
  const [state, formAction] = useActionState<CanalActionState, FormData>(salvarCanal, {})
  const [kind, setKind] = useState<TipoDeCanal>('n8n')
  const [abreChamado, setAbreChamado] = useState(true)
  const [copiado, setCopiado] = useState(false)

  /*
   * A URL é montada no navegador porque é o único lugar que sabe o endereço
   * público real. Montá-la no servidor exigiria uma variável de ambiente com o
   * domínio, que estaria errada em toda instalação que esquecesse de ajustá-la —
   * e uma URL de webhook errada é um canal que nunca recebe nada, sem erro.
   */
  const origem = typeof window !== 'undefined' ? window.location.origin : ''
  const url = state.plainToken ? `${origem}/api/canais/${state.plainToken}` : null

  return (
    <Card title="Ligar um canal">
      <p className="mb-4 text-sm text-[var(--color-ink-2)]">
        Ao salvar, o sistema gera a <strong>URL de entrada</strong> deste canal. Ela aparece uma
        única vez: é por ela que as mensagens chegam, então ela é a credencial de entrada.
      </p>

      <form action={formAction} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome do canal" htmlFor="name" required>
            <input
              id="name"
              name="name"
              required
              minLength={2}
              maxLength={120}
              className={inputClass}
              placeholder="WhatsApp da matriz"
            />
          </Field>

          <Field label="Tipo" htmlFor="kind" required>
            <select
              id="kind"
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as TipoDeCanal)}
              className={inputClass}
            >
              {(Object.keys(ROTULO_DO_CANAL) as TipoDeCanal[]).map((k) => (
                <option key={k} value={k}>
                  {ROTULO_DO_CANAL[k]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3.5"
          aria-live="polite"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
            O que {ROTULO_DO_CANAL[kind]} exige
          </p>
          <ListaDeExigencias kind={kind} className="mt-1.5" />
        </div>

        <Field
          label="Variável com a credencial de envio"
          htmlFor="secret_ref"
          hint="O NOME da variável de ambiente, nunca o valor. Em branco: o canal recebe e não responde."
        >
          <input
            id="secret_ref"
            name="secret_ref"
            className={`${inputClass} font-mono`}
            placeholder={SECRET_EXEMPLO[kind] || 'não se aplica a este tipo'}
            pattern="[A-Z][A-Z0-9_]{2,60}"
          />
        </Field>

        <Field
          label="Configuração"
          htmlFor="config"
          hint="JSON com o que o adaptador deste tipo lê. Campos terminados em _ref também são nomes de variáveis."
        >
          <textarea
            id="config"
            name="config"
            rows={5}
            /* `key` força o React a recriar o campo quando o tipo muda: sem
               isso, `defaultValue` não reavalia e o modelo continuaria sendo o
               do tipo anterior. */
            key={kind}
            defaultValue={MODELO[kind]}
            className={`${inputClass} font-mono`}
            spellCheck={false}
          />
        </Field>

        <label className="flex items-start gap-2.5 text-sm text-[var(--color-ink)]">
          <input
            type="checkbox"
            name="abre_chamado"
            checked={abreChamado}
            onChange={(e) => setAbreChamado(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Abrir chamado para cada conversa nova
            <span className="block text-xs text-[var(--color-ink-3)]">
              Desmarcado, as mensagens ficam registradas e ninguém é avisado — serve para observar
              um canal antes de colocá-lo em produção.
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Fila do chamado" htmlFor="default_queue_id" required={abreChamado}>
            <select
              id="default_queue_id"
              name="default_queue_id"
              defaultValue=""
              required={abreChamado}
              className={inputClass}
            >
              <option value="">—</option>
              {filas.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Prioridade" htmlFor="default_priority_id" required={abreChamado}>
            <select
              id="default_priority_id"
              name="default_priority_id"
              defaultValue=""
              required={abreChamado}
              className={inputClass}
            >
              <option value="">—</option>
              {prioridades.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Cliente padrão"
            htmlFor="default_client_id"
            hint="Use só em canal de um cliente só."
          >
            <select id="default_client_id" name="default_client_id" defaultValue="" className={inputClass}>
              <option value="">Descobrir pelo contato</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {state.error && <ErrorNote>{state.error}</ErrorNote>}

        <SubmitButton pendingLabel="Criando…">Criar canal e gerar a URL</SubmitButton>
      </form>

      {url && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-[var(--color-ok-ink)]/30 bg-[var(--color-ok-soft)] p-3.5"
        >
          <p className="text-sm font-semibold text-[var(--color-ok-ink)]">
            Canal criado — copie a URL agora
          </p>
          <p className="mt-1 text-xs text-[var(--color-ok-ink)]">
            Ela não aparece de novo: o sistema guarda só o resumo criptográfico. Se perder, crie
            outro canal e apague este.
          </p>
          <code className="mt-2 block overflow-x-auto whitespace-nowrap rounded bg-[var(--color-surface)] p-2 font-mono text-xs">
            {url}
          </code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(url)
              setCopiado(true)
            }}
            className="mt-2 rounded-lg border border-[var(--color-ok-ink)]/40 px-3 py-1.5 text-xs font-semibold text-[var(--color-ok-ink)]"
          >
            {copiado ? 'Copiado!' : 'Copiar URL'}
          </button>
          {kind === 'whatsapp' && (
            <p className="mt-2 text-xs text-[var(--color-ok-ink)]">
              No painel da Meta, cole esta URL em <strong>Callback URL</strong> e use o trecho final
              dela (depois da última barra) como <strong>Verify token</strong>. São o mesmo valor.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
