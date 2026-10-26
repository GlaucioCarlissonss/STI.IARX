import { describe, expect, it } from 'vitest'
import { emptyToNull, optionalUuid } from './campos'
describe('campo ausente no formulário', () => {
  /*
   * `formData.get('x')` devolve `null` quando o campo não existe — o que é
   * comum e legítimo: `id` só existe na edição, `parent_task_id` só na
   * subtarefa. Antes desta correção o Zod recusava com "expected string,
   * received null", e o formulário de cadastro de serviço passou uma onda
   * inteira sem nunca ter criado um serviço.
   */
  it('emptyToNull aceita nulo como vazio', () => {
    expect(emptyToNull.parse(null)).toBeNull()
    expect(emptyToNull.parse(undefined)).toBeNull()
    expect(emptyToNull.parse('')).toBeNull()
    expect(emptyToNull.parse('  ')).toBeNull()
    expect(emptyToNull.parse(' abc ')).toBe('abc')
  })

  it('optionalUuid aceita nulo, e continua recusando lixo', () => {
    expect(optionalUuid.parse(null)).toBeNull()
    expect(optionalUuid.parse('')).toBeNull()
    expect(optionalUuid.parse('a0000000-0000-4000-8000-000000000001')).toBe(
      'a0000000-0000-4000-8000-000000000001',
    )
    expect(optionalUuid.safeParse('nao-e-uuid').success).toBe(false)
  })
})
