'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireSession, requirePermission } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import {
  ATTACHMENT_TARGETS,
  BUCKET,
  SIGNED_URL_TTL,
  attachmentCategory,
  attachmentPath,
  isAttachmentEntity,
  validateFile,
} from '@/lib/storage'

/*
 * Anexo é a mesma operação em três módulos (ticket, ativo, linha), então as ações
 * moram num lugar só em vez de triplicadas em `tickets/`, `inventario/` e
 * `telefonia/`. A pasta não tem `page.tsx`: não é tela, é só o módulo de ações.
 *
 * Nenhuma destas ações usa `service_role`. O upload sai pelo cliente da sessão,
 * então as policies do bucket (migração 0019) decidem — e é isso que faz o
 * Storage ter a mesma fronteira de tenant do resto do banco.
 */

const NOT_AFFECTED = 'Não foi possível concluir: registro não encontrado ou sem permissão.'

/** Mensagem única para os dois motivos, de propósito — ver `requirePermission`. */
function falha(mensagem?: string): ActionState {
  return { error: mensagem ?? NOT_AFFECTED }
}

export async function attachFile(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const entity = formData.get('entity')
  if (!isAttachmentEntity(entity)) return falha('Tipo de anexo inválido.')
  const target = ATTACHMENT_TARGETS[entity]

  const gate = await requirePermission(target.permissions.anexar)
  if ('error' in gate) return gate
  const { profile } = await requireSession()
  if (!profile.tenant_id) return falha('Sessão sem tenant.')

  const entityId = String(formData.get('entityId') ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(entityId)) return falha('Registro inválido.')

  const file = formData.get('file')
  if (!(file instanceof File)) return falha('Selecione um arquivo.')

  const rejeitado = validateFile(file)
  if (rejeitado) return rejeitado

  // `kind` só é enviado onde a tabela cobra. Em ticket a trigger deriva do MIME,
  // então mandar valor daqui seria escrever algo que o banco sobrescreve.
  let kind: string | null = null
  if (target.kinds.length > 0) {
    const enviado = String(formData.get('kind') ?? '')
    if (!target.kinds.some((k) => k.value === enviado)) return falha('Selecione o tipo do anexo.')
    kind = enviado
  }

  const supabase = await createClient()
  const path = attachmentPath({
    tenantId: profile.tenant_id,
    entity,
    entityId,
    fileName: file.name,
    unique: randomUUID().slice(0, 8),
  })

  /*
   * Ordem: binário primeiro, metadado depois.
   *
   * O inverso deixaria a tabela apontando para arquivo que não existe caso o
   * upload falhasse, e a tela mostraria um anexo que não abre. Nesta ordem o
   * risco é o oposto — objeto órfão no bucket se o insert falhar — e esse caso é
   * tratado logo abaixo com remoção compensatória, porque ele é esperado: a
   * trigger de cota da 0013 recusa o insert quando o ticket estoura o limite do
   * tenant, e aí o arquivo já subiu.
   */
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false })

  if (upErr) {
    // A policy de INSERT do bucket nega sem dizer o motivo, e é assim que deve
    // ser. Traduzir para a mensagem única evita revelar se o registro existe.
    return falha(
      /policy|unauthorized|forbidden/i.test(upErr.message)
        ? undefined
        : `Falha no upload: ${upErr.message}`,
    )
  }

  const registro: Record<string, unknown> = {
    tenant_id: profile.tenant_id,
    [target.fkColumn]: entityId,
    storage_path: path,
    file_name: file.name,
    mime_type: file.type,
    size_bytes: file.size,
    uploaded_by: profile.id,
  }
  if (kind) registro.kind = kind
  if (target.hasCategory && kind) registro.category = attachmentCategory(kind)

  const { error: insErr } = await supabase.from(target.table).insert(registro)

  if (insErr) {
    // Compensação: sem isto a cota estourada deixaria lixo pago no bucket a cada
    // tentativa, e ninguém teria como listar esse lixo — não há metadado.
    await supabase.storage.from(BUCKET).remove([path])

    // `check_violation` é o código que a trigger de cota levanta. A mensagem dela
    // já diz o limite e o uso, então vale mais que a genérica.
    if (insErr.code === '23514') return falha(insErr.message)
    if (insErr.code === '23505') return falha('Este arquivo já foi anexado.')
    return falha(insErr.message)
  }

  revalidatePath(target.revalidate)
  return { success: `${file.name} anexado.` }
}

export async function removeAttachment(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const entity = formData.get('entity')
  if (!isAttachmentEntity(entity)) return falha('Tipo de anexo inválido.')
  const target = ATTACHMENT_TARGETS[entity]

  const gate = await requirePermission(target.permissions.remover)
  if ('error' in gate) return gate

  const id = String(formData.get('id') ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) return falha('Registro inválido.')

  const supabase = await createClient()

  /*
   * Metadado primeiro, com `.select()` para saber se saiu de fato: RLS nega
   * devolvendo zero linhas em vez de erro, e sem esta checagem a tela diria
   * "removido" com o anexo intacto.
   *
   * O binário depois. Se a remoção do objeto falhar sobra um órfão no bucket —
   * ruim, mas melhor que o contrário: metadado apontando para arquivo apagado
   * mostraria na tela um anexo que não abre, e ninguém saberia por quê.
   */
  const { data: removidos, error } = await supabase
    .from(target.table)
    .delete()
    .eq('id', id)
    .select('storage_path')

  if (error) return falha(error.message)
  if (!removidos || removidos.length === 0) return falha()

  const path = (removidos[0] as { storage_path: string }).storage_path
  const { error: rmErr } = await supabase.storage.from(BUCKET).remove([path])

  revalidatePath(target.revalidate)
  return rmErr
    ? {
        success:
          'Anexo removido da listagem. O arquivo no armazenamento não pôde ser apagado agora.',
      }
    : { success: 'Anexo removido.' }
}

/**
 * URL assinada para baixar.
 *
 * O bucket é privado, então não existe link permanente — e é isso que se quer:
 * anexo de ticket de Home Care pode conter dado de saúde, e link eterno vaza por
 * histórico de navegador, e-mail encaminhado ou print. A URL vale
 * SIGNED_URL_TTL segundos.
 */
export async function signAttachmentUrl(
  entity: string,
  storagePath: string,
): Promise<{ url: string } | { error: string }> {
  if (!isAttachmentEntity(entity)) return { error: 'Tipo de anexo inválido.' }
  const target = ATTACHMENT_TARGETS[entity]

  const gate = await requirePermission(target.permissions.ver)
  if ('error' in gate) return gate

  const supabase = await createClient()
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL)

  if (error || !data) return { error: NOT_AFFECTED }
  return { url: data.signedUrl }
}
