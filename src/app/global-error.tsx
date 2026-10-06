'use client'

/**
 * O último recurso: o próprio layout raiz falhou.
 *
 * Por isso este arquivo traz `<html>` e `<body>` próprios — quando ele entra em
 * cena, o layout que normalmente os fornece é justamente o que quebrou. E por
 * isso também ele não usa nenhum componente, token ou classe do sistema: se a
 * folha de estilos não carregou, uma tela pintada por `var(--color-ink)`
 * apareceria como texto preto sobre fundo preto. Os estilos aqui são embutidos e
 * absolutos, de propósito.
 *
 * Em desenvolvimento este arquivo quase nunca aparece — o Next mostra o próprio
 * relatório. Ele existe para produção, e é lá que precisa funcionar sem depender
 * de nada.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#f6f7f9',
          color: '#131820',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', margin: 0 }}>O sistema não conseguiu abrir</h1>
          <p style={{ fontSize: '0.9rem', color: '#474f5e', marginTop: '0.75rem' }}>
            A falha foi registrada. Tente de novo; se continuar, avise o suporte.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              padding: '0.6rem 1.1rem',
              borderRadius: '0.5rem',
              border: 0,
              background: '#1d4ed8',
              color: '#ffffff',
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Tentar de novo
          </button>
          {error.digest && (
            <p style={{ fontSize: '0.75rem', color: '#68717f', marginTop: '1.5rem' }}>
              Código da falha:{' '}
              <span style={{ fontFamily: 'ui-monospace, monospace' }}>{error.digest}</span>
            </p>
          )}
        </div>
      </body>
    </html>
  )
}
