'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { ErrorNote, Field, inputClass } from '@/components/ui'
import { salvarArtigo } from './actions'

export interface ArtigoInicial {
  id?: string
  title?: string
  resumo?: string | null
  body?: string
  category_id?: string | null
  visibilidade?: string
  status?: string
  source_ticket_id?: string | null
}

/**
 * O formulário de artigo, usado para criar e para editar.
 *
 * ## Por que a visibilidade tem um aviso e a publicação não
 *
 * Publicar é reversível e esperado: o texto fica pronto, publica-se. Liberar
 * para o solicitante é a decisão que, feita por engano, coloca a senha do
 * roteador na tela de um cliente — e não dá para "despublicar" o que alguém já
 * leu.
 *
 * Por isso o padrão é `interno` e a opção que libera carrega a frase que explica
 * o que ela significa. O campo não pergunta "qual a visibilidade?"; ele pergunta
 * **quem vai poder ler isto**, que é a pergunta que a pessoa consegue responder.
 */
export function ArtigoForm({
  inicial = {},
  categorias,
}: {
  inicial?: ArtigoInicial
  categorias: { id: string; name: string }[]
}) {
  const [state, action] = useActionState(salvarArtigo, {})

  return (
    <form action={action} className="flex flex-col gap-4">
      {inicial.id && <input type="hidden" name="id" value={inicial.id} />}
      {inicial.source_ticket_id && (
        <input type="hidden" name="source_ticket_id" value={inicial.source_ticket_id} />
      )}

      <Field label="Título" htmlFor="title" required>
        <input
          id="title"
          name="title"
          required
          minLength={3}
          maxLength={200}
          defaultValue={inicial.title ?? ''}
          className={inputClass}
          placeholder="Impressora não imprime em rede"
        />
      </Field>

      <Field label="Resumo de uma linha" htmlFor="resumo">
        <input
          id="resumo"
          name="resumo"
          maxLength={300}
          defaultValue={inicial.resumo ?? ''}
          className={inputClass}
          placeholder="O que esta pessoa vai conseguir resolver lendo isto"
        />
        <p className="mt-1 text-xs text-[var(--color-ink-3)]">
          É o que aparece no resultado da busca. Sem ele, quem procura vê só o título e tem de
          abrir o artigo para saber se é o certo.
        </p>
      </Field>

      <Field label="Categoria" htmlFor="category_id">
        <select
          id="category_id"
          name="category_id"
          defaultValue={inicial.category_id ?? ''}
          className={inputClass}
        >
          <option value="">Sem categoria</option>
          {categorias.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-[var(--color-ink-3)]">
          A mesma categoria dos chamados. É por ela que este artigo volta a aparecer no próximo
          chamado parecido.
        </p>
      </Field>

      <Field label="Conteúdo" htmlFor="body" required>
        <textarea
          id="body"
          name="body"
          required
          minLength={10}
          rows={18}
          defaultValue={inicial.body ?? ''}
          className={`${inputClass} font-mono text-sm`}
        />
        <p className="mt-1 text-xs text-[var(--color-ink-3)]">
          Texto simples, com quebras de linha. Não há formatação — e é de propósito: o artigo é
          lido por gente de fora da equipe, e interpretar marcação de terceiro num texto público é
          um risco que não paga o que ganharia em negrito.
        </p>
      </Field>

      <fieldset className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3.5">
        <legend className="px-1 text-sm font-medium text-[var(--color-ink)]">Quem pode ler</legend>
        <label className="flex items-start gap-2 text-sm text-[var(--color-ink-2)]">
          <input
            type="radio"
            name="visibilidade"
            value="interno"
            defaultChecked={(inicial.visibilidade ?? 'interno') === 'interno'}
            className="mt-1"
          />
          <span>
            <strong>Só a equipe.</strong> Quem atende chamados. É o padrão.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-[var(--color-ink-2)]">
          <input
            type="radio"
            name="visibilidade"
            value="solicitante"
            defaultChecked={inicial.visibilidade === 'solicitante'}
            className="mt-1"
          />
          <span>
            <strong>Todos, inclusive quem abre chamado.</strong> Aparece no portal — inclusive para
            gente da empresa-cliente. Não ponha senha, endereço interno nem nome de servidor aqui.
          </span>
        </label>
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-[var(--color-ink-2)]">
        <input
          type="checkbox"
          name="publicar"
          defaultChecked={inicial.status === 'publicado'}
        />
        Publicar agora — sem isto, fica como rascunho e não aparece na busca.
      </label>

      {state.error && <ErrorNote>{state.error}</ErrorNote>}
      {state.success && (
        <p role="status" className="text-sm text-[var(--color-ok-ink)]">
          {state.success}
        </p>
      )}

      <SubmitButton pendingLabel="Salvando…">
        {inicial.id ? 'Salvar artigo' : 'Criar artigo'}
      </SubmitButton>
    </form>
  )
}
