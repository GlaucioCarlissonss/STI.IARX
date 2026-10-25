import { EXIGENCIAS_DO_CANAL, type TipoDeCanal } from '@/lib/canais/registro'

/**
 * As exigências de um tipo de canal, com as crases viradas em `<code>`.
 *
 * ## Por que num módulo próprio
 *
 * Ela é usada pela página (componente de servidor) e pelo formulário (`'use
 * client'`). Exportá-la do formulário compilaria, mas quebraria em produção:
 * tudo que um componente de servidor importa de um módulo `'use client'` vira
 * uma *referência* de cliente, e chamar uma referência como função estoura. Um
 * módulo sem diretiva serve aos dois lados — é o mesmo código, empacotado onde
 * for preciso.
 */
export function ListaDeExigencias({
  kind,
  className = '',
}: {
  kind: TipoDeCanal
  className?: string
}) {
  return (
    <ul className={`flex list-disc flex-col gap-1 pl-5 text-sm text-[var(--color-ink-2)] ${className}`}>
      {EXIGENCIAS_DO_CANAL[kind].map((e) => (
        <li key={e}>
          {e.split('`').map((parte, i) =>
            i % 2 === 1 ? (
              <code key={i} className="font-mono text-xs">
                {parte}
              </code>
            ) : (
              <span key={i}>{parte}</span>
            ),
          )}
        </li>
      ))}
    </ul>
  )
}
