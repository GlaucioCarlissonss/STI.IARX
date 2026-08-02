import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Só a lógica pura é testada por unidade. O comportamento de banco (RLS,
    // SLA, máquina de estados) é verificado contra um PostgreSQL real em
    // supabase/tests/schema_test.sql — mockar o Postgres não provaria nada
    // sobre policies.
    include: ['src/**/*.test.ts'],
  },
})
