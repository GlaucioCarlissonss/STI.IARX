import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PERMISSION_CATALOG } from './permissions'

/*
 * Este arquivo não testa lógica: ele varre o código-fonte e cobra que toda
 * chave de AÇÃO do catálogo seja consultada em algum lugar.
 *
 * O motivo é concreto. A entrega das permissões deixou 6 chaves cadastradas que
 * não governavam nada — `sla.definicoes.ver`, `sla.contratos.ver`,
 * `sla.categorias.ver`, `sla.prioridades.ver`, `clientes.filiais.ver` e
 * `fornecedores.contratos.ver` apareciam na matriz de perfis, o administrador
 * desmarcava e ninguém perdia acesso. Configuração morta é pior que ausência de
 * configuração: promete um controle que não existe.
 *
 * A convenção que isto impõe é que a chave apareça literal no código. Guarda com
 * chave montada em template string quebra este teste de propósito — sem chave
 * literal não há como auditar a superfície por leitura.
 *
 * Chaves de MÓDULO e de TELA ficam fora: elas são consumidas estruturalmente por
 * `can()` (herança), `canAnyInModule()` (menu) e `catalogTree()` (matriz), não
 * por guarda direta.
 */

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(path, acc)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) acc.push(path)
  }
  return acc
}

const SELF = join('src', 'lib', 'permissions.ts')
const CODE = sourceFiles('src')
  .filter((f) => f !== SELF)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

describe('catálogo de permissões × código', () => {
  it('toda chave de ação é consultada em algum guard, gate ou <Can>', () => {
    const inertes = PERMISSION_CATALOG.filter(
      (p) => p.action !== null && !CODE.includes(`'${p.key}'`),
    ).map((p) => p.key)

    expect(inertes).toEqual([])
  })
})
