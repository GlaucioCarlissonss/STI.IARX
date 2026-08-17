import { describe, expect, it } from 'vitest'
import {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  ROLE_RANK,
  can,
  canAnyInModule,
  catalogTree,
  permissionEntry,
  unreachableForRole,
  withAncestors,
} from './permissions'

/**
 * A regra sob teste é "negação herda para baixo, liberação é explícita".
 * É o tipo de regra que passa a impressão de funcionar quando está invertida:
 * um `can()` que só olhasse a própria chave pareceria correto em todo teste
 * feliz e liberaria tela sensível ao primeiro grant órfão.
 */

const granted = (...keys: string[]) => new Set(keys)

describe('can — herança', () => {
  it('nega quando não há grant nenhum', () => {
    expect(can(granted(), 'financeiro.contas_bancarias.criar')).toBe(false)
  })

  it('liberar o módulo NÃO libera a tela', () => {
    expect(can(granted('financeiro'), 'financeiro.contas_bancarias')).toBe(false)
  })

  it('liberar o módulo e a tela NÃO libera a ação', () => {
    expect(can(granted('financeiro', 'financeiro.contas_bancarias'),
      'financeiro.contas_bancarias.criar')).toBe(false)
  })

  it('libera a ação quando módulo, tela e ação estão concedidos', () => {
    expect(can(
      granted('financeiro', 'financeiro.contas_bancarias', 'financeiro.contas_bancarias.criar'),
      'financeiro.contas_bancarias.criar',
    )).toBe(true)
  })

  it('grant órfão de ação, sem o módulo, não vale — é o caso da despromoção mal feita', () => {
    expect(can(
      granted('financeiro.contas_bancarias', 'financeiro.contas_bancarias.criar'),
      'financeiro.contas_bancarias.criar',
    )).toBe(false)
  })

  it('perder o módulo derruba tudo que estava dentro dele', () => {
    const completo = granted('sla', 'sla.definicoes', 'sla.definicoes.editar')
    expect(can(completo, 'sla.definicoes.editar')).toBe(true)
    const semModulo = granted('sla.definicoes', 'sla.definicoes.editar')
    expect(can(semModulo, 'sla.definicoes.editar')).toBe(false)
    expect(can(semModulo, 'sla.definicoes')).toBe(false)
  })

  it('uma tela liberada não vaza para outra tela do mesmo módulo', () => {
    const g = granted('sla', 'sla.categorias', 'sla.categorias.criar')
    expect(can(g, 'sla.categorias.criar')).toBe(true)
    expect(can(g, 'sla.definicoes.criar')).toBe(false)
  })

  it('chave de módulo é satisfeita pelo próprio grant do módulo', () => {
    expect(can(granted('helpdesk'), 'helpdesk')).toBe(true)
  })
})

describe('canAnyInModule', () => {
  it('falso sem o grant do módulo, mesmo com ações marcadas', () => {
    expect(canAnyInModule(granted('inventario.ativos', 'inventario.ativos.ver'), 'inventario'))
      .toBe(false)
  })

  it('falso com o módulo mas sem nenhuma ação efetiva — não põe item morto no menu', () => {
    expect(canAnyInModule(granted('inventario'), 'inventario')).toBe(false)
  })

  it('verdadeiro quando existe ao menos uma ação exercível', () => {
    expect(canAnyInModule(
      granted('inventario', 'inventario.ativos', 'inventario.ativos.ver'), 'inventario',
    )).toBe(true)
  })
})

describe('withAncestors', () => {
  it('marcar a ação fecha tela e módulo', () => {
    expect(withAncestors(['financeiro.contas_bancarias.criar'])).toEqual([
      'financeiro', 'financeiro.contas_bancarias', 'financeiro.contas_bancarias.criar',
    ])
  })

  it('não duplica ancestral comum a várias ações', () => {
    const out = withAncestors([
      'sla.categorias.criar', 'sla.categorias.editar', 'sla.prioridades.ver',
    ])
    expect(out.filter((k) => k === 'sla')).toHaveLength(1)
    expect(out).toContain('sla.prioridades')
  })

  it('descarta chave que não existe no catálogo', () => {
    expect(withAncestors(['financeiro.tesouraria.criar', 'inventario.ativos.ver'])).toEqual([
      'inventario', 'inventario.ativos', 'inventario.ativos.ver',
    ])
  })

  it('o resultado passa por can() para as chaves de origem', () => {
    const set = new Set(withAncestors(['tv.tokens.revogar']))
    expect(can(set, 'tv.tokens.revogar')).toBe(true)
  })
})

describe('unreachableForRole', () => {
  it('acusa permissão de admin concedida a perfil de base gestor', () => {
    expect(unreachableForRole(['usuarios.perfis.editar'], 'gestor'))
      .toEqual(['usuarios.perfis.editar'])
  })

  it('não acusa nada quando o papel alcança', () => {
    expect(unreachableForRole(['usuarios.perfis.editar'], 'admin')).toEqual([])
  })

  it('atendente não alcança cadastro de ativo, mas alcança consulta', () => {
    expect(unreachableForRole(['inventario.ativos.criar'], 'atendente'))
      .toEqual(['inventario.ativos.criar'])
    expect(unreachableForRole(['inventario.ativos.ver'], 'atendente')).toEqual([])
  })

  it('super_admin alcança tudo do catálogo', () => {
    expect(unreachableForRole(PERMISSION_KEYS, 'super_admin')).toEqual([])
  })
})

describe('integridade do catálogo', () => {
  it('não tem chave repetida', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length)
  })

  it('a chave sempre corresponde à trinca módulo/tela/ação', () => {
    for (const p of PERMISSION_CATALOG) {
      const esperado = [p.module, p.screen, p.action].filter(Boolean).join('.')
      expect(p.key).toBe(esperado)
    }
  })

  it('toda tela e ação tem o ancestral declarado no catálogo', () => {
    for (const p of PERMISSION_CATALOG) {
      const parts = p.key.split('.')
      for (let i = 1; i < parts.length; i += 1) {
        expect(permissionEntry(parts.slice(0, i).join('.'))).toBeDefined()
      }
    }
  })

  it('a ação nunca exige papel menor que a tela ou o módulo que a contém', () => {
    for (const p of PERMISSION_CATALOG) {
      const parts = p.key.split('.')
      for (let i = 1; i < parts.length; i += 1) {
        const pai = permissionEntry(parts.slice(0, i).join('.'))!
        expect(ROLE_RANK[p.minBaseRole]).toBeGreaterThanOrEqual(ROLE_RANK[pai.minBaseRole])
      }
    }
  })

  it('toda tela tem ao menos uma ação — tela sem ação não é configurável', () => {
    for (const m of catalogTree()) {
      for (const s of m.screens) expect(s.actions.length).toBeGreaterThan(0)
    }
  })

  it('todo módulo tem ao menos uma tela', () => {
    for (const m of catalogTree()) expect(m.screens.length).toBeGreaterThan(0)
  })

  it('a árvore cobre exatamente o catálogo plano', () => {
    const naArvore = catalogTree().flatMap((m) => [
      m.key, ...m.screens.flatMap((s) => [s.key, ...s.actions.map((a) => a.key)]),
    ])
    expect(naArvore.sort()).toEqual([...PERMISSION_KEYS].sort())
  })

  it('toda ação de leitura se chama "ver", para o gate de tela ser previsível', () => {
    for (const m of catalogTree()) {
      for (const s of m.screens) {
        expect(s.actions.some((a) => a.action === 'ver')).toBe(true)
      }
    }
  })
})
