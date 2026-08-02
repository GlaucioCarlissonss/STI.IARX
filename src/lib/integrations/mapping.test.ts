import { describe, expect, it } from 'vitest'
import {
  applyMapping,
  buildEventKey,
  camelToUpperSnake,
  getByPath,
  htmlToText,
  normalizeBitrixTask,
  parseWebhookBody,
  toIsoDate,
  type MappingRule,
} from './mapping'

describe('getByPath', () => {
  it('lê caminho aninhado', () => {
    const payload = { data: { FIELDS_AFTER: { ID: '42' } } }
    expect(getByPath(payload, 'data.FIELDS_AFTER.ID')).toBe('42')
  })

  it('lê índice de array', () => {
    expect(getByPath({ tags: ['rede', 'urgente'] }, 'tags.1')).toBe('urgente')
  })

  it('devolve undefined em caminho inexistente sem lançar', () => {
    expect(getByPath({ a: 1 }, 'a.b.c')).toBeUndefined()
    expect(getByPath(null, 'a')).toBeUndefined()
    expect(getByPath({ a: 1 }, '')).toBeUndefined()
  })
})

describe('parseWebhookBody', () => {
  it('interpreta form-urlencoded com colchetes PHP, que é o formato do Bitrix24', () => {
    const body =
      'event=ONTASKUPDATE&data%5BFIELDS_AFTER%5D%5BID%5D=1042&ts=1770000000&auth%5Bapplication_token%5D=abc123'

    const parsed = parseWebhookBody(body, 'application/x-www-form-urlencoded')

    expect(parsed.event).toBe('ONTASKUPDATE')
    expect(parsed.ts).toBe('1770000000')
    expect((parsed.data as Record<string, Record<string, string>>).FIELDS_AFTER.ID).toBe('1042')
    expect((parsed.auth as Record<string, string>).application_token).toBe('abc123')
  })

  it('interpreta JSON', () => {
    const parsed = parseWebhookBody('{"event":"ONTASKADD","id":7}', 'application/json')
    expect(parsed.event).toBe('ONTASKADD')
    expect(parsed.id).toBe(7)
  })

  it('devolve objeto vazio em JSON malformado em vez de lançar', () => {
    expect(parseWebhookBody('{quebrado', 'application/json')).toEqual({})
  })
})

describe('htmlToText', () => {
  it('remove HTML e BBCode', () => {
    expect(htmlToText('<p>Olá <b>mundo</b></p>')).toBe('Olá mundo')
    expect(htmlToText('[B]Importante[/B] verificar')).toBe('Importante verificar')
  })

  it('converte <br> em quebra de linha e decodifica entidades', () => {
    expect(htmlToText('linha 1<br>linha 2')).toBe('linha 1\nlinha 2')
    expect(htmlToText('a &amp; b &lt;c&gt;')).toBe('a & b <c>')
  })
})

describe('toIsoDate', () => {
  it('aceita ISO 8601 com offset e normaliza para UTC', () => {
    expect(toIsoDate('2026-08-05T14:30:00+03:00')).toBe('2026-08-05T11:30:00.000Z')
  })

  it('aceita o formato legado dd.mm.yyyy do Bitrix24', () => {
    expect(toIsoDate('05.08.2026 14:30:00')).toBe('2026-08-05T14:30:00.000Z')
    expect(toIsoDate('05.08.2026')).toBe('2026-08-05T00:00:00.000Z')
  })

  it('devolve null em data inválida ou vazia', () => {
    expect(toIsoDate('não é data')).toBeNull()
    expect(toIsoDate('   ')).toBeNull()
  })
})

describe('camelToUpperSnake / normalizeBitrixTask', () => {
  it('converte camelCase e preserva UPPER_SNAKE', () => {
    expect(camelToUpperSnake('responsibleId')).toBe('RESPONSIBLE_ID')
    expect(camelToUpperSnake('title')).toBe('TITLE')
    expect(camelToUpperSnake('CREATED_DATE')).toBe('CREATED_DATE')
  })

  it('normaliza a resposta de tasks.task.get, que vem em camelCase', () => {
    const task = normalizeBitrixTask({ id: '10', title: 'Falha', responsibleId: '7' })
    expect(task).toEqual({ ID: '10', TITLE: 'Falha', RESPONSIBLE_ID: '7' })
  })
})

describe('buildEventKey', () => {
  it('inclui o timestamp para que duas edições distintas sejam eventos distintos', () => {
    expect(buildEventKey('ONTASKUPDATE', '1042', '1770000000')).toBe('ONTASKUPDATE:1042:1770000000')
    expect(buildEventKey('ONTASKUPDATE', '1042', '1770000001')).not.toBe(
      buildEventKey('ONTASKUPDATE', '1042', '1770000000'),
    )
  })

  it('funciona sem timestamp', () => {
    expect(buildEventKey('ontaskadd', '9')).toBe('ONTASKADD:9')
  })
})

describe('applyMapping', () => {
  const rules: MappingRule[] = [
    { source_path: 'TITLE', target_field: 'title', transform: 'direct', is_required: true },
    { source_path: 'DESCRIPTION', target_field: 'description', transform: 'html_to_text' },
    {
      source_path: 'PRIORITY',
      target_field: 'priority_key',
      transform: 'value_map',
      value_map: { '2': 'high', '1': 'medium', '0': 'low' },
    },
    {
      source_path: 'STATUS',
      target_field: 'status',
      transform: 'value_map',
      value_map: { '2': 'open', '3': 'in_progress', '5': 'resolved' },
    },
    { source_path: 'RESPONSIBLE_ID', target_field: 'assignee_id', transform: 'user_by_external_id' },
    { source_path: 'TAGS', target_field: 'tags', transform: 'direct' },
  ]

  it('mapeia uma tarefa completa do Bitrix24', () => {
    const result = applyMapping(
      {
        TITLE: 'Internet caiu',
        DESCRIPTION: '<p>Sem link desde as <b>08h</b></p>',
        PRIORITY: '2',
        STATUS: '3',
        RESPONSIBLE_ID: '7',
        TAGS: ['rede', 'urgente'],
      },
      rules,
    )

    expect(result.errors).toEqual([])
    expect(result.fields.title).toBe('Internet caiu')
    expect(result.fields.description).toBe('Sem link desde as 08h')
    expect(result.fields.priority_key).toBe('high')
    expect(result.fields.status).toBe('in_progress')
    expect(result.fields.tags).toEqual(['rede', 'urgente'])
    // Campo que depende do banco sai como lookup, não como valor.
    expect(result.fields.assignee_id).toBeUndefined()
    expect(result.lookups).toEqual([
      { target_field: 'assignee_id', kind: 'user_by_external_id', value: '7' },
    ])
  })

  it('reporta campo obrigatório ausente', () => {
    const result = applyMapping({ DESCRIPTION: 'só isso' }, rules)
    expect(result.errors).toContain('Campo obrigatório ausente no payload: TITLE')
  })

  it('usa default quando o campo está ausente', () => {
    const result = applyMapping({ TITLE: 'x' }, [
      ...rules,
      {
        source_path: 'CATEGORY',
        target_field: 'category_id',
        transform: 'direct',
        default_value: 'padrao',
      },
    ])
    expect(result.fields.category_id).toBe('padrao')
  })

  it('avisa sobre valor não mapeado sem descartar o resto do ticket', () => {
    // Cenário real: o Bitrix24 ganha um status novo que ninguém mapeou ainda.
    const result = applyMapping({ TITLE: 'Chamado', STATUS: '99' }, rules)

    expect(result.fields.title).toBe('Chamado')
    expect(result.fields.status).toBeUndefined()
    expect(result.errors.some((e) => e.includes('Valor não mapeado'))).toBe(true)
  })

  it('trata transform constant sem consultar o payload', () => {
    const result = applyMapping(
      {},
      [{ source_path: '', target_field: 'source', transform: 'constant', default_value: 'bitrix24' }],
    )
    expect(result.fields.source).toBe('bitrix24')
  })

  it('reporta data inválida', () => {
    const result = applyMapping({ DEADLINE: 'ontem' }, [
      { source_path: 'DEADLINE', target_field: 'deadline', transform: 'datetime' },
    ])
    expect(result.errors.some((e) => e.includes('Data inválida'))).toBe(true)
  })

  it('ignora string vazia como se o campo não existisse', () => {
    const result = applyMapping({ TITLE: 'ok', DESCRIPTION: '' }, rules)
    expect(result.fields.description).toBeUndefined()
    expect(result.errors).toEqual([])
  })
})
