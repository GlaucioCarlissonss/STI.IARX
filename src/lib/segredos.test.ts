import { describe, expect, it } from 'vitest'
import { explicarSegredosExpostos, segredosExpostos } from './segredos'

/*
 * Uma guarda nunca exercitada é indistinguível de uma guarda quebrada. Metade
 * destes testes prova que ela ACUSA; a outra metade, que ela não acusa o que é
 * legítimo — porque uma guarda que grita à toa é desligada na segunda semana.
 */

describe('segredosExpostos — o que ela precisa acusar', () => {
  it('acusa a chave de serviço, que é o erro que custa tudo', () => {
    const achados = segredosExpostos({
      NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'eyJhbG...',
    })
    expect(achados).toHaveLength(1)
    expect(achados[0].porque).toMatch(/ignora todo o RLS/)
  })

  it('acusa o que se anuncia como segredo, senha ou privado', () => {
    const achados = segredosExpostos({
      NEXT_PUBLIC_JOBS_SECRET: 'x',
      NEXT_PUBLIC_DB_PASSWORD: 'x',
      NEXT_PUBLIC_PRIVATE_KEY: 'x',
    })
    expect(achados.map((a) => a.variavel).sort()).toEqual([
      'NEXT_PUBLIC_DB_PASSWORD',
      'NEXT_PUBLIC_JOBS_SECRET',
      'NEXT_PUBLIC_PRIVATE_KEY',
    ])
  })

  it('acusa credencial de provedor — a que vira fatura', () => {
    const achados = segredosExpostos({
      NEXT_PUBLIC_ANTHROPIC_API_KEY: 'sk-ant-...',
      NEXT_PUBLIC_RESEND_API_KEY: 're_...',
    })
    expect(achados).toHaveLength(2)
  })

  it('acusa a URL do banco, que carrega usuário e senha', () => {
    const achados = segredosExpostos({ NEXT_PUBLIC_DATABASE_URL: 'postgres://u:p@h/d' })
    expect(achados[0].porque).toMatch(/usuário e senha/)
  })

  it('acusa um segredo que ainda não existe no projeto', () => {
    /* O ponto da lista de PADRÕES: ela cobre o próximo segredo, que ninguém
       vai lembrar de acrescentar a uma lista de nomes. */
    const achados = segredosExpostos({ NEXT_PUBLIC_STRIPE_SECRET_KEY: 'sk_live_...' })
    expect(achados).toHaveLength(1)
  })
})

describe('segredosExpostos — o que ela NÃO pode acusar', () => {
  it('deixa passar as públicas por desenho', () => {
    const achados = segredosExpostos({
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbG...',
      NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: 'AIza...',
    })
    expect(achados).toEqual([])
  })

  it('ignora o que NÃO vai para o navegador', () => {
    // O servidor pode e deve ter segredos. O problema é só o prefixo.
    const achados = segredosExpostos({
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbG...',
      JOBS_SECRET: 'x',
      DATABASE_URL: 'postgres://u:p@h/d',
    })
    expect(achados).toEqual([])
  })

  it('não confunde "KEY" sozinho com segredo', () => {
    /* `API_KEY` de mapa é pública por desenho. Marcá-la como erro ensinaria a
       desligar a guarda — e aí ela não protege mais nada. */
    expect(segredosExpostos({ NEXT_PUBLIC_MAP_API_KEY: 'x' })).toEqual([])
  })

  it('o ambiente real deste repositório está limpo', () => {
    expect(segredosExpostos(process.env)).toEqual([])
  })
})

describe('explicarSegredosExpostos', () => {
  it('diz COMO corrigir, e não só o que está errado', () => {
    const texto = explicarSegredosExpostos(
      segredosExpostos({ NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'x' }),
    )
    expect(texto).toMatch(/Corrija tirando o prefixo: SUPABASE_SERVICE_ROLE_KEY/)
    expect(texto).toMatch(/texto legível na aba de rede/)
  })

  it('é vazio quando não há o que dizer', () => {
    expect(explicarSegredosExpostos([])).toBe('')
  })
})
