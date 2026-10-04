import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  /*
   * O mesmo `@/` do `tsconfig.json`. Sem ele, um teste que importasse um módulo
   * de `src/components` falhava com "Cannot find package '@/lib/maps'" — o
   * caminho resolvia no editor e no build, e só não resolvia aqui. Testes que
   * mudam de forma conforme o atalho do import é o tipo de diferença que faz
   * alguém evitar escrever o teste.
   */
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // Só a lógica pura é testada por unidade. O comportamento de banco (RLS,
    // SLA, máquina de estados) é verificado contra um PostgreSQL real em
    // supabase/tests/schema_test.sql — mockar o Postgres não provaria nada
    // sobre policies.
    include: ['src/**/*.test.ts'],
  },
})
