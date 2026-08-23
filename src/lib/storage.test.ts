import { describe, expect, it } from 'vitest'
import {
  ALLOWED_MIME_TYPES,
  ATTACHMENT_ENTITIES,
  ATTACHMENT_TARGETS,
  MAX_FILE_BYTES,
  attachmentCategory,
  attachmentPath,
  fileKindLabel,
  formatBytes,
  isAttachmentEntity,
  safeFileName,
  validateFile,
} from './storage'
import { PERMISSION_KEYS } from './permissions'

const TENANT = 'a0000000-0000-4000-8000-000000000001'
const ENTIDADE = '11110000-0000-4000-8000-000000000009'

describe('safeFileName', () => {
  it('remove acento, espaço e símbolo — o Storage aceitaria e depois não devolveria', () => {
    expect(safeFileName('Nota Fiscal Nº 123 – Ação.pdf')).toBe('nota-fiscal-n-123-acao.pdf')
    expect(safeFileName('café.jpeg')).toBe('cafe.jpeg')
  })

  it('nunca devolve vazio — caminho terminando em barra viraria pasta', () => {
    expect(safeFileName('###')).toBe('arquivo')
    expect(safeFileName('')).toBe('arquivo')
    expect(safeFileName('...')).toBe('arquivo')
  })

  it('não começa nem termina com ponto ou hífen', () => {
    for (const n of ['.oculto', '-inicio', 'fim-', 'fim.', '..a..']) {
      const r = safeFileName(n)
      expect(r).not.toMatch(/^[.-]/)
      expect(r).not.toMatch(/[.-]$/)
    }
  })

  it('limita o tamanho', () => {
    expect(safeFileName(`${'a'.repeat(400)}.pdf`).length).toBeLessThanOrEqual(120)
  })
})

describe('attachmentPath', () => {
  const caminho = (fileName: string, unique = 'abcd1234') =>
    attachmentPath({ tenantId: TENANT, entity: 'tickets', entityId: ENTIDADE, fileName, unique })

  it('põe o tenant no PRIMEIRO segmento — é dele que a policy lê', () => {
    expect(caminho('nota.pdf').split('/')[0]).toBe(TENANT)
  })

  it('tem exatamente 3 pastas antes do arquivo, como can_touch_attachment exige', () => {
    const partes = caminho('nota.pdf').split('/')
    expect(partes).toHaveLength(4)
    expect(partes[1]).toBe('tickets')
    expect(partes[2]).toBe(ENTIDADE)
  })

  it('o sufixo separa dois uploads do mesmo nome', () => {
    // Sem isto o segundo upload sobreporia o primeiro, e nas tabelas com
    // storage_path UNIQUE o insert estouraria em vez de funcionar.
    expect(caminho('nota.pdf', 'aaaa1111')).not.toBe(caminho('nota.pdf', 'bbbb2222'))
  })
})

describe('validateFile', () => {
  const arquivo = (over: Partial<{ size: number; type: string; name: string }> = {}) => ({
    size: 1024,
    type: 'application/pdf',
    name: 'nota.pdf',
    ...over,
  })

  it('aceita o que o bucket aceita', () => {
    for (const type of ALLOWED_MIME_TYPES) {
      expect(validateFile(arquivo({ type }))).toBeNull()
    }
  })

  it('recusa arquivo vazio', () => {
    expect(validateFile(arquivo({ size: 0 }))?.error).toMatch(/vazio/i)
  })

  it('recusa acima do limite e diz o tamanho', () => {
    const r = validateFile(arquivo({ size: MAX_FILE_BYTES + 1 }))
    expect(r?.error).toMatch(/25 MB/)
  })

  it('aceita exatamente no limite', () => {
    expect(validateFile(arquivo({ size: MAX_FILE_BYTES }))).toBeNull()
  })

  it('recusa tipo não aceito e tipo ausente com mensagens diferentes', () => {
    expect(validateFile(arquivo({ type: 'application/x-msdownload' }))?.error).toMatch(/não aceito/i)
    expect(validateFile(arquivo({ type: '' }))?.error).toMatch(/identificar o tipo/i)
  })
})

describe('ATTACHMENT_TARGETS', () => {
  it('cobre exatamente as entidades declaradas', () => {
    expect(Object.keys(ATTACHMENT_TARGETS).sort()).toEqual([...ATTACHMENT_ENTITIES].sort())
  })

  it('toda permissão usada existe no catálogo — chave inventada aqui negaria em silêncio', () => {
    for (const t of Object.values(ATTACHMENT_TARGETS)) {
      for (const key of Object.values(t.permissions)) {
        expect(PERMISSION_KEYS).toContain(key)
      }
    }
  })

  it('ticket não oferece tipo: a trigger da 0013 deriva do MIME', () => {
    expect(ATTACHMENT_TARGETS.tickets.kinds).toHaveLength(0)
  })

  it('as outras duas exigem tipo', () => {
    expect(ATTACHMENT_TARGETS.ativos.kinds.length).toBeGreaterThan(0)
    expect(ATTACHMENT_TARGETS.linhas.kinds.length).toBeGreaterThan(0)
  })

  it('só asset_attachments tem coluna category', () => {
    expect(ATTACHMENT_TARGETS.ativos.hasCategory).toBe(true)
    expect(ATTACHMENT_TARGETS.linhas.hasCategory).toBe(false)
    expect(ATTACHMENT_TARGETS.tickets.hasCategory).toBe(false)
  })

  it('links fica fora — a tela não existe, e chave sem tela é configuração morta', () => {
    expect(isAttachmentEntity('links')).toBe(false)
    expect(PERMISSION_KEYS.some((k) => k.includes('links'))).toBe(false)
  })
})

describe('attachmentCategory', () => {
  it('deriva photo de todo kind photo_*, para o CHECK photo_is_image fechar', () => {
    for (const k of ATTACHMENT_TARGETS.ativos.kinds) {
      expect(attachmentCategory(k.value)).toBe(k.value.startsWith('photo_') ? 'photo' : 'document')
    }
  })
})

describe('rótulos', () => {
  it('fileKindLabel não devolve MIME cru', () => {
    expect(fileKindLabel('application/pdf')).toBe('PDF')
    expect(fileKindLabel('image/png')).toBe('imagem')
    expect(fileKindLabel('text/csv')).toBe('planilha')
    expect(fileKindLabel(null)).toBe('arquivo')
    expect(fileKindLabel('application/octet-stream')).toBe('arquivo')
  })

  it('formatBytes lida com ausência', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5_242_880)).toBe('5.0 MB')
  })
})
