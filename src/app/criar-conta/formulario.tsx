'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { ErrorNote, Field, inputClass } from '@/components/ui'
import { criarConta, type CadastroState } from './actions'

function Botao() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-ink)] disabled:opacity-60"
    >
      {pending ? 'Criando…' : 'Começar avaliação'}
    </button>
  )
}

export function FormularioDeCadastro({ dias }: { dias: number }) {
  const [state, acao] = useActionState<CadastroState, FormData>(criarConta, {})

  /*
   * Depois de enviar, o formulário SAI de cena.
   *
   * A mensagem fala de e-mail enviado, e deixar os campos preenchidos embaixo
   * dela convidaria a clicar de novo — o que, com o freio por origem, acabaria
   * gastando as três tentativas da hora sem produzir nada.
   */
  if (state.enviado) {
    return (
      <div className="flex flex-col gap-3 text-center">
        <p
          role="status"
          className="rounded-lg bg-[var(--color-ok-soft)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-ok-ink)]"
        >
          Se este e-mail ainda não tiver conta, o link de confirmação já está a caminho.
        </p>
        <p className="text-sm text-[var(--color-ink-2)]">
          Ele vale por 48 horas e serve uma vez só. Enquanto você não confirmar, a conta existe
          e não entra — é assim que garantimos que ninguém se cadastra com o endereço de outra
          pessoa.
        </p>
        <Link href="/login" className="text-sm text-[var(--color-brand)] hover:underline">
          Voltar para a entrada
        </Link>
      </div>
    )
  }

  return (
    <form action={acao} className="flex flex-col gap-4">
      <Field label="Seu nome" htmlFor="nome" required>
        <input id="nome" name="nome" type="text" autoComplete="name" required className={inputClass} />
      </Field>

      <Field label="Nome da empresa" htmlFor="empresa" required>
        <input
          id="empresa"
          name="empresa"
          type="text"
          autoComplete="organization"
          required
          className={inputClass}
        />
      </Field>

      <Field
        label="E-mail de trabalho"
        htmlFor="email"
        required
        hint="É para ele que vai o link de confirmação."
      >
        <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
      </Field>

      <Field
        label="Senha"
        htmlFor="senha"
        required
        hint="Pelo menos 12 caracteres — esta é a senha do administrador da empresa."
      >
        <input
          id="senha"
          name="senha"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          className={inputClass}
        />
      </Field>

      {/*
        * A esfera decide QUAIS TELAS EXISTEM para a empresa, e perguntar aqui
        * evita que alguém que só aluga equipamento conheça o produto por um
        * menu cheio de coisa que não se aplica. Dá para mudar depois.
        */}
      <Field label="O que a sua empresa faz" htmlFor="esferas" required>
        <select id="esferas" name="esferas" defaultValue="management" className={inputClass}>
          <option value="management">Gestão de TI e suporte</option>
          <option value="rental">Locação de equipamentos</option>
          <option value="ambas">As duas coisas</option>
        </select>
      </Field>

      {state.error && <ErrorNote>{state.error}</ErrorNote>}

      <Botao />

      <p className="text-center text-xs text-[var(--color-ink-3)]">
        {dias} dias de avaliação, sem cartão de crédito.
      </p>
    </form>
  )
}
