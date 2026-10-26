import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve } from 'node:path'

/**
 * O armazenamento do modo local: arquivos em disco, URL assinada.
 *
 * ## O que foi mantido do Supabase Storage, e por quê
 *
 * **A URL expira.** O app assina a URL no clique, nunca na renderização, e
 * conta com a expiração de cinco minutos (ver `attachment-forms.tsx`). Servir
 * um caminho estático aqui facilitaria a vida e quebraria essa garantia
 * justamente no ambiente em que as pessoas experimentam.
 *
 * **O caminho é conferido.** Um `storage_path` com `..` sairia da pasta de
 * anexos e leria qualquer arquivo do servidor. O Supabase não tem esse problema
 * porque não existe sistema de arquivos do outro lado; aqui existe, e é a
 * primeira coisa que alguém tentaria.
 *
 * ## O que NÃO foi mantido
 *
 * As policies de `storage.objects`. No Supabase elas valem por cima da sessão;
 * aqui o arquivo é servido por uma rota que confere a assinatura, e quem assina
 * é a Server Action que já conferiu permissão no banco antes. A diferença está
 * registrada em docs/22 — é a maior do modo local, e não é invisível.
 */

const PASTA = process.env.LOCAL_STORAGE_DIR ?? '.local-storage'

function segredo(): string {
  return process.env.LOCAL_AUTH_SECRET ?? 'segredo-de-desenvolvimento-local'
}

function caminhoSeguro(bucket: string, caminho: string): string {
  const raiz = resolve(PASTA, bucket)
  const alvo = resolve(raiz, normalize(caminho))
  if (alvo !== raiz && !alvo.startsWith(raiz + '/')) {
    throw new Error('caminho de anexo fora da pasta do bucket')
  }
  return alvo
}

export function assinarCaminho(bucket: string, caminho: string, segundos: number): string {
  const expira = Math.floor(Date.now() / 1000) + segundos
  const dado = `${bucket}:${caminho}:${expira}`
  const assinatura = createHmac('sha256', segredo()).update(dado).digest('base64url')
  const params = new URLSearchParams({ b: bucket, p: caminho, e: String(expira), s: assinatura })
  return `/api/anexo-local?${params.toString()}`
}

export function conferirAssinatura(
  bucket: string,
  caminho: string,
  expira: string,
  assinatura: string,
): boolean {
  const limite = Number(expira)
  if (!Number.isFinite(limite) || limite < Math.floor(Date.now() / 1000)) return false

  const esperada = createHmac('sha256', segredo())
    .update(`${bucket}:${caminho}:${limite}`)
    .digest('base64url')
  const a = Buffer.from(assinatura)
  const b = Buffer.from(esperada)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function gravar(
  bucket: string,
  caminho: string,
  conteudo: Buffer,
): Promise<void> {
  const alvo = caminhoSeguro(bucket, caminho)
  await mkdir(dirname(alvo), { recursive: true })
  await writeFile(alvo, conteudo)
}

export async function ler(bucket: string, caminho: string): Promise<Buffer> {
  return readFile(caminhoSeguro(bucket, caminho))
}

export async function remover(bucket: string, caminhos: string[]): Promise<void> {
  for (const caminho of caminhos) {
    try {
      await unlink(caminhoSeguro(bucket, caminho))
    } catch {
      /* Arquivo já ausente não é erro: a remoção é idempotente, e o registro no
         banco é a fonte da verdade sobre o que existe. */
    }
  }
}

export function pastaDoBucket(bucket: string): string {
  return join(PASTA, bucket)
}
