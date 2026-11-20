import type { Metadata } from 'next'
import Link from 'next/link'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Entrar' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ proxima?: string; motivo?: string }>
}) {
  const { proxima, motivo } = await searchParams

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface-2)] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-2xl font-bold tracking-tight text-[var(--color-brand)]">STI</p>
          <h1 className="mt-2 text-lg font-semibold text-[var(--color-ink)]">
            Helpdesk e Gestão de TI
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">
            Entre com suas credenciais para continuar.
          </p>
        </div>

        {/*
          * Por que a pessoa foi parar aqui.
          *
          * Quem é desativado no meio do trabalho é devolvido para esta tela por
          * `/auth/encerrar`, que apaga o cookie. Sem esta explicação, o que ela
          * veria é um formulário em branco no lugar do que estava fazendo — e
          * concluiria que o sistema caiu.
          */}
        {/*
          * CADA MOTIVO DIZ UMA COISA, porque cada um pede uma ação diferente.
          *
          * Antes havia um só, e ele era usado para tudo: com o banco parado, a
          * tela dizia que a CONTA estava desativada. A pessoa ia procurar o
          * administrador da empresa, que confirmaria que a conta está ativa, e
          * ninguém avisaria quem cuida do servidor.
          *
          * `sem-perfil` existe separado de `inativa` porque reativar não
          * resolve: a conta existe na autenticação e não tem vínculo com
          * empresa nenhuma. São conselhos diferentes para quem recebe o pedido.
          */}
        {motivo === 'inativa' && (
          <div
            role="status"
            className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn-ink)]"
          >
            A sua sessão foi encerrada porque esta conta está desativada. Procure o administrador
            da sua empresa para reativá-la.
          </div>
        )}

        {motivo === 'sem-perfil' && (
          <div
            role="status"
            className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn-ink)]"
          >
            Esta conta existe, mas ainda não está vinculada a nenhuma empresa. Peça a quem
            administra para enviar um convite — reativar a conta não resolve este caso.
          </div>
        )}

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <LoginForm proxima={proxima} />
        </div>

        <p className="mt-4 text-center text-sm">
          <Link
            href="/recuperar-senha"
            className="font-medium text-[var(--color-brand-ink)] hover:underline"
          >
            Esqueci minha senha
          </Link>
        </p>

        <p className="mt-2 text-center text-sm text-[var(--color-ink-2)]">
          Ainda não tem conta?{' '}
          <Link href="/criar-conta" className="font-medium text-[var(--color-brand-ink)] hover:underline">
            Criar a conta da sua empresa
          </Link>
        </p>

        <p className="mt-6 text-center text-xs text-[var(--color-ink-3)]">
          Painéis de TV não usam esta tela — eles são acessados por token de exibição.
        </p>
      </div>
    </main>
  )
}
