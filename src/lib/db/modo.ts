/**
 * O interruptor entre Supabase e PostgreSQL local.
 *
 * ## Por que a decisão é por AUSÊNCIA de configuração do Supabase
 *
 * Porque é o único critério que não erra para o lado perigoso. Uma variável
 * `MODO=local` esquecida ligada em produção faria o app tentar falar com um
 * banco local que não existe — e, pior, se existisse, falaria com o banco
 * errado em silêncio.
 *
 * Aqui é o contrário: com `NEXT_PUBLIC_SUPABASE_URL` apontando para um Supabase
 * de verdade, o modo local **não liga de jeito nenhum**. Ele só entra quando a
 * URL está ausente ou é o `placeholder` que a suíte de navegador usa, e quando
 * existe um `DATABASE_URL` para falar.
 *
 * ## O que isto NÃO é
 *
 * Não é um dublê de teste. O banco é PostgreSQL de verdade, com as mesmas
 * migrações, as mesmas policies e os mesmos papéis — `anon`, `authenticated` e
 * `service_role` com `bypassrls`. O que muda é o transporte: em vez de HTTP
 * para o PostgREST, uma conexão direta. É por isso que vale como ambiente de
 * desenvolvimento, e é por isso que o RLS continua sendo o que decide tudo.
 */
export function modoLocal(): boolean {
  if (!process.env.DATABASE_URL) return false

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const semSupabase = url === '' || url.includes('placeholder')
  return semSupabase
}
