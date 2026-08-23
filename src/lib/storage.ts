/**
 * Anexos no Supabase Storage.
 *
 * Um lugar só para a convenção de caminho, os limites de arquivo e a URL
 * assinada. As quatro tabelas de anexo (`ticket_attachments`,
 * `asset_attachments`, `telecom_line_attachments`, `internet_link_attachments`)
 * guardam metadados; o binário vive no bucket privado `anexos`.
 *
 * O que este módulo NÃO faz, de propósito: usar `service_role`. O upload sai pelo
 * cliente da sessão do usuário, então as policies da migração 0019 se aplicam. O
 * ADR-011 sanciona exatamente dois usos daquela chave — a rota `/tv/[token]` e o
 * provisionamento de usuário — e abrir um terceiro por conveniência de upload
 * contornaria a própria camada de autorização que o bucket tem.
 */

export const BUCKET = 'anexos'

/** Teto de UM arquivo. A cota por ticket é do tenant e vive no banco. */
export const MAX_FILE_BYTES = 26_214_400 // 25 MiB, igual ao `file_size_limit` do bucket.

/**
 * Entidades que podem receber anexo.
 *
 * Espelha `app.storage_permission_key()` na 0019. `links` está fora nos dois
 * lugares porque a tela de Links de Internet não existe na aplicação — permissão
 * sem tela é configuração morta.
 */
export const ATTACHMENT_ENTITIES = ['tickets', 'ativos', 'linhas'] as const
export type AttachmentEntity = (typeof ATTACHMENT_ENTITIES)[number]

/**
 * Tipos aceitos, iguais ao `allowed_mime_types` do bucket.
 *
 * Duas listas com a mesma verdade é risco de divergir, mas a alternativa é pior:
 * sem checagem aqui, o arquivo recusado só falharia depois de subir a rede toda,
 * e a mensagem viria do Storage em inglês. O teste de schema compara as duas.
 */
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/xml',
  'text/xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/csv',
] as const

/** Segundos de validade da URL assinada. */
export const SIGNED_URL_TTL = 300

/**
 * Normaliza o nome do arquivo para caber num caminho de Storage.
 *
 * Acento, espaço e caractere de controle no nome viram caminho que o Storage
 * rejeita ou, pior, aceita e depois não devolve. O nome original continua em
 * `file_name` na tabela de metadados — é ele que a pessoa vê na tela.
 */
export function safeFileName(original: string): string {
  const normalizado = original
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase()

  // Nome que sobra vazio (um arquivo chamado "###.pdf") não pode virar caminho
  // terminando em barra — o Storage trataria como pasta.
  return normalizado.length > 0 ? normalizado.slice(0, 120) : 'arquivo'
}

/**
 * O caminho no bucket: `{tenant_id}/{entidade}/{entity_id}/{sufixo}-{arquivo}`.
 *
 * A convenção não é nova: `supabase/seed.sql` já grava
 * `{tenant_id}/{link_id}/contrato.pdf`. O primeiro segmento ser o tenant é o que
 * dá ao Storage a mesma fronteira de isolamento do resto do banco (ADR-002), e a
 * policy da 0019 lê exatamente daí.
 *
 * O sufixo aleatório evita que dois uploads do mesmo nome se sobreponham. Sem
 * ele, anexar "nota.pdf" duas vezes substituiria o primeiro sem avisar — e as
 * três tabelas de 0013 têm `storage_path` UNIQUE, então o segundo insert
 * estouraria com erro de duplicidade em vez de funcionar.
 */
export function attachmentPath(input: {
  tenantId: string
  entity: AttachmentEntity
  entityId: string
  fileName: string
  unique: string
}): string {
  const { tenantId, entity, entityId, fileName, unique } = input
  return `${tenantId}/${entity}/${entityId}/${unique}-${safeFileName(fileName)}`
}

export interface FileRejection {
  error: string
}

/**
 * Valida o arquivo ANTES de subir.
 *
 * Devolve `null` quando está tudo certo, para o chamador poder escrever
 * `const bad = validateFile(f); if (bad) return bad`.
 */
export function validateFile(file: { size: number; type: string; name: string }): FileRejection | null {
  if (file.size === 0) {
    return { error: 'O arquivo está vazio.' }
  }
  if (file.size > MAX_FILE_BYTES) {
    const mb = (file.size / 1_048_576).toFixed(1)
    return { error: `Arquivo de ${mb} MB excede o limite de 25 MB por anexo.` }
  }
  // `type` vem do navegador e pode chegar vazio. Recusar o desconhecido é a
  // escolha certa aqui: o bucket também recusaria, e a mensagem de lá seria pior.
  if (!ALLOWED_MIME_TYPES.includes(file.type as (typeof ALLOWED_MIME_TYPES)[number])) {
    return {
      error: file.type
        ? `Tipo de arquivo não aceito (${file.type}). Envie PDF, imagem, planilha ou documento.`
        : 'Não foi possível identificar o tipo do arquivo. Envie PDF, imagem, planilha ou documento.',
    }
  }
  return null
}

/** Rótulo curto para o tipo, para a lista de anexos não mostrar MIME cru. */
export function fileKindLabel(mime: string | null): string {
  if (!mime) return 'arquivo'
  if (mime === 'application/pdf') return 'PDF'
  if (mime.startsWith('image/')) return 'imagem'
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime === 'text/csv') return 'planilha'
  if (mime.includes('word')) return 'documento'
  if (mime.includes('xml')) return 'XML'
  if (mime.startsWith('text/')) return 'texto'
  return 'arquivo'
}

/** Tamanho legível. `null` quando o metadado não foi gravado. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

/**
 * O que muda de uma entidade para outra.
 *
 * As três tabelas de anexo não são iguais: `asset_attachments` exige `category` e
 * `kind`, `telecom_line_attachments` exige `kind`, e `ticket_attachments` deriva o
 * `kind` por trigger a partir do MIME (`app.derive_attachment_kind`, 0013:376) —
 * então ali não se envia nada. Sem esta tabela, a ação de anexar teria três
 * ramos `if` e cada mudança de coluna precisaria ser lembrada em três lugares.
 *
 * As chaves de permissão são LITERAIS de propósito. Montá-las por template
 * (`helpdesk.tickets.${verbo}`) faria o teste
 * `src/lib/permissions.usage.test.ts` deixar de encontrá-las, e ele existe
 * justamente para provar que toda chave do catálogo governa algo.
 */
export interface AttachmentKind {
  value: string
  label: string
}

export interface AttachmentTarget {
  entity: AttachmentEntity
  /** Tabela de metadados. */
  table: string
  /** Coluna que aponta para a entidade dona. */
  fkColumn: string
  /** Rota a revalidar depois de anexar ou remover. */
  revalidate: string
  permissions: { ver: string; anexar: string; remover: string }
  /** Vazio quando a tabela deriva o tipo sozinha. */
  kinds: readonly AttachmentKind[]
  /** `asset_attachments` separa documento de foto numa coluna própria. */
  hasCategory: boolean
}

export const ATTACHMENT_TARGETS: Record<AttachmentEntity, AttachmentTarget> = {
  tickets: {
    entity: 'tickets',
    table: 'ticket_attachments',
    fkColumn: 'ticket_id',
    revalidate: '/tickets',
    permissions: {
      ver: 'helpdesk.tickets.ver',
      anexar: 'helpdesk.tickets.anexar',
      remover: 'helpdesk.tickets.remover_anexo',
    },
    // Vazio: a trigger da 0013 deriva `kind` do MIME. Oferecer o campo aqui daria
    // à pessoa uma escolha que o banco ia sobrescrever.
    kinds: [],
    hasCategory: false,
  },
  ativos: {
    entity: 'ativos',
    table: 'asset_attachments',
    fkColumn: 'asset_id',
    revalidate: '/inventario',
    permissions: {
      ver: 'inventario.ativos.ver',
      anexar: 'inventario.ativos.anexar',
      remover: 'inventario.ativos.remover_anexo',
    },
    kinds: [
      { value: 'nfe', label: 'Nota fiscal (NF-e)' },
      { value: 'cte', label: 'Conhecimento de transporte (CT-e)' },
      { value: 'receipt', label: 'Recibo' },
      { value: 'contract', label: 'Contrato' },
      { value: 'warranty', label: 'Termo de garantia' },
      { value: 'photo_front', label: 'Foto — frente' },
      { value: 'photo_back', label: 'Foto — traseira' },
      { value: 'photo_tag', label: 'Foto — etiqueta de patrimônio' },
      { value: 'photo_serial', label: 'Foto — número de série' },
      { value: 'photo_other', label: 'Foto — outra' },
    ],
    hasCategory: true,
  },
  linhas: {
    entity: 'linhas',
    table: 'telecom_line_attachments',
    fkColumn: 'line_id',
    revalidate: '/telefonia',
    permissions: {
      ver: 'telefonia.linhas.ver',
      anexar: 'telefonia.linhas.anexar',
      remover: 'telefonia.linhas.remover_anexo',
    },
    kinds: [
      { value: 'contract', label: 'Contrato' },
      { value: 'amendment', label: 'Adendo' },
      { value: 'loyalty_term', label: 'Termo de fidelidade' },
      { value: 'cancellation', label: 'Termo de cancelamento' },
      { value: 'invoice', label: 'Fatura' },
      { value: 'other', label: 'Outro' },
    ],
    // `telecom_line_attachments` não tem coluna `category`, mas exige `kind`.
    hasCategory: false,
  },
}

/**
 * `category` de `asset_attachments`: a coluna tem CHECK ('document','photo') e a
 * tabela ainda cobra `photo_is_image` — foto com MIME que não é imagem é
 * recusada. Derivar do `kind` escolhido mantém as duas colunas coerentes sem
 * pedir a mesma informação duas vezes na tela.
 */
export function attachmentCategory(kind: string): 'document' | 'photo' {
  return kind.startsWith('photo_') ? 'photo' : 'document'
}

export function isAttachmentEntity(value: unknown): value is AttachmentEntity {
  return typeof value === 'string' && (ATTACHMENT_ENTITIES as readonly string[]).includes(value)
}
