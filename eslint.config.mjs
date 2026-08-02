import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

/**
 * Flat config nativo. O `eslint-config-next` 16 já exporta arrays de flat
 * config, então envolvê-lo em `FlatCompat` (padrão dos projetos Next 14/15)
 * quebra com erro de estrutura circular.
 */
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Edge Functions rodam em Deno (imports por URL, global `Deno`) — o parser
    // e as regras deste config são de Node/Next e só produziriam falso positivo.
    ignores: ['.next/**', 'node_modules/**', 'supabase/functions/**'],
  },
]

export default config
