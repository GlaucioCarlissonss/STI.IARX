'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { requirePermission, requireSession } from '@/lib/session'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { uuid } from '@/lib/schemas/campos'
import { lerCsv, PlanilhaInvalida, sugerirDePara } from '@/lib/planilha/leitura'
import {
  chaveDaLinha,
  conferirCnpj,
  conferirLinha,
  faltamObrigatorias,
  recusou,
  soDigitos,
  type LinhaConferida,
} from '@/lib/planilha/conferencia'
import { camposChave, recursoPorChave, type RecursoDeImportacao } from '@/lib/planilha/recursos'

function revalida() {
  revalidatePath('/sistema/planilhas')
}

/** 4 MiB: cinco mil linhas de cadastro cabem com folga, e um PDF não. */
const MAX_BYTES = 4 * 1024 * 1024

/**
 * Confere a planilha e grava a PRÉVIA — sem tocar no negócio.
 *
 * O lote nasce em `preview`: `import_rows` recebe o que vai acontecer com cada
 * linha, e nenhuma tabela de cadastro é escrita. É esta separação que permite
 * mostrar "305 entram, 7 recusadas" antes de a pessoa decidir.
 *
 * A permissão aqui é dupla, e as duas são necessárias: `sistema.planilhas.importar`
 * diz que a pessoa pode usar o importador, e a chave do RECURSO diz que ela
 * poderia criar aquilo à mão. Sem a segunda, o importador viraria o caminho
 * para escrever onde a tela nega.
 */
export async function conferirPlanilha(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('sistema.planilhas.importar', {
    papel: 'config',
    mensagem: 'Sem permissão para importar planilha.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const chave = String(formData.get('recurso') ?? '')
  const recurso = recursoPorChave(chave)
  if (!recurso) return { error: 'Recurso inválido.' }

  const doRecurso = await requirePermission(recurso.permissao)
  if ('error' in doRecurso) {
    return {
      error: `Você não pode cadastrar ${recurso.rotulo.toLowerCase()} — o importador não amplia o que a tela permite.`,
    }
  }

  const arquivo = formData.get('arquivo')
  if (!(arquivo instanceof File) || arquivo.size === 0) {
    return { error: 'Selecione um arquivo CSV.' }
  }
  if (arquivo.size > MAX_BYTES) {
    return {
      error: `O arquivo tem ${(arquivo.size / 1024 / 1024).toFixed(1)} MB, e o limite é 4 MB. Divida a planilha.`,
    }
  }
  if (/\.xlsx?$/i.test(arquivo.name)) {
    /* Dizer antes de ler é mais honesto que aceitar e falhar no meio: o XLSX é
       um ZIP, e o leitor veria bytes binários e reclamaria de "planilha vazia". */
    return {
      error:
        'Arquivos .xls e .xlsx não são lidos. No Excel, use “Salvar como → CSV UTF-8” e envie o CSV.',
    }
  }

  let planilha
  try {
    planilha = lerCsv(await arquivo.text())
  } catch (e) {
    if (e instanceof PlanilhaInvalida) return { error: e.message }
    return { error: 'Não foi possível ler o arquivo. Confirme que é um CSV.' }
  }

  const dePara = sugerirDePara(planilha.cabecalho, recurso.campos)
  const faltando = faltamObrigatorias(recurso, dePara)
  if (faltando.length > 0) {
    /* A mensagem traz o cabeçalho que veio: sem isso, quem montou a planilha
       fica comparando a lista de exigências com o arquivo, de cabeça. */
    return {
      error: `A planilha não tem ${faltando.length === 1 ? 'a coluna' : 'as colunas'} ${faltando.map((f) => `“${f}”`).join(', ')}. O cabeçalho enviado foi: ${planilha.cabecalho.filter(Boolean).join(', ')}.`,
    }
  }

  const supabase = await createClient()

  const { data: lote, error: erroLote } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: profile.tenant_id,
      resource: recurso.chave,
      file_name: arquivo.name,
      file_bytes: arquivo.size,
      on_conflict: recurso.somenteCriacao ? 'skip' : String(formData.get('conflito') ?? 'update'),
      column_map: dePara,
      created_by: profile.id,
    })
    .select('id, on_conflict')
    .single<{ id: string; on_conflict: string }>()
  if (erroLote) return { error: mensagemDeErro(erroLote) }

  const conferidas = planilha.linhas.map((l) =>
    conferirLinha(recurso, dePara, l.celulas, l.numero),
  )

  const resolucao = await resolverReferencias(supabase, recurso, conferidas)
  const existentes = await buscarExistentes(supabase, recurso, conferidas, resolucao)

  /* Chave repetida DENTRO do arquivo: a segunda linha sobrescreveria a primeira
     sem ninguém ver qual venceu. Recusar a repetida mostra as duas. */
  const vistas = new Map<string, number>()
  const registros: Record<string, unknown>[] = []

  for (const linha of conferidas) {
    const erros = [...linha.erros]

    for (const [campo, texto] of Object.entries(linha.referencias)) {
      const achado = resolucao.get(`${campo}\u0000${texto.toLowerCase()}`)
      if (achado === undefined) {
        const def = recurso.campos.find((c) => c.nome === campo)
        erros.push(
          `${def?.titulo ?? campo}: não há ${def?.referencia?.nome ?? 'registro'} com “${texto}”.`,
        )
      } else if (achado === null) {
        const def = recurso.campos.find((c) => c.nome === campo)
        erros.push(
          `${def?.titulo ?? campo}: “${texto}” corresponde a mais de um ${def?.referencia?.nome ?? 'registro'} — use um identificador único.`,
        )
      } else {
        linha.valores[campo] = achado
      }
    }

    /* O CNPJ é a chave de cliente: um dígito trocado cria um registro que
       ninguém procura e que reaparece como duplicata meses depois. */
    if (recurso.tabela === 'clients' && typeof linha.valores.cnpj === 'string') {
      const r = conferirCnpj(linha.valores.cnpj)
      if (recusou(r)) erros.push(`CNPJ: ${r.erro}`)
      else linha.valores.cnpj = r.valor
    }

    const chaveNatural = chaveDaLinha(recurso, linha)
    if (chaveNatural && vistas.has(chaveNatural)) {
      erros.push(
        `esta chave já aparece na linha ${vistas.get(chaveNatural)} do mesmo arquivo — duas linhas iguais escreveriam uma por cima da outra.`,
      )
    } else if (chaveNatural) {
      vistas.set(chaveNatural, linha.numero)
    }

    let outcome: 'create' | 'update' | 'skip' | 'reject' = 'create'
    let reason: string | null = null
    if (erros.length > 0) {
      outcome = 'reject'
      reason = erros.join(' ')
    } else if (chaveNatural && existentes.has(chaveNatural)) {
      outcome = lote.on_conflict === 'skip' ? 'skip' : 'update'
    }

    registros.push({
      tenant_id: profile.tenant_id,
      batch_id: lote.id,
      line_number: linha.numero,
      raw: { cru: linha.cru, valores: linha.valores, existente: chaveNatural ? (existentes.get(chaveNatural) ?? null) : null },
      outcome,
      reason,
    })
  }

  /* Em blocos: cinco mil linhas num `insert` só estouram o limite da requisição
     do PostgREST, e o erro que volta fala de tamanho de corpo, não de planilha. */
  for (let i = 0; i < registros.length; i += 500) {
    const { error } = await supabase.from('import_rows').insert(registros.slice(i, i + 500))
    if (error) {
      await supabase.from('import_batches').delete().eq('id', lote.id)
      return { error: mensagemDeErro(error) }
    }
  }

  revalida()
  return { success: `Planilha conferida: ${registros.length} linha(s). Nada foi gravado ainda.` }
}

/**
 * Resolve os campos de referência em UMA consulta por tabela.
 *
 * Uma consulta por linha faria uma planilha de mil leituras disparar mil
 * buscas de equipamento — e a conferência passaria de segundos a minutos.
 *
 * O valor `null` no mapa quer dizer AMBÍGUO: duas filiais com o mesmo nome.
 * Escolher a primeira seria decidir no lugar de quem importa, e errado na
 * metade das vezes.
 */
async function resolverReferencias(
  supabase: Awaited<ReturnType<typeof createClient>>,
  recurso: RecursoDeImportacao,
  linhas: readonly LinhaConferida[],
): Promise<Map<string, string | null>> {
  const mapa = new Map<string, string | null>()

  for (const campo of recurso.campos.filter((c) => c.tipo === 'referencia' && c.referencia)) {
    const ref = campo.referencia!
    const procurados = new Set<string>()
    for (const l of linhas) {
      const t = l.referencias[campo.nome]
      if (t) procurados.add(t)
    }
    if (procurados.size === 0) continue

    const colunas = ['id', ...ref.por].join(', ')
    const { data } = await supabase
      .from(ref.tabela)
      .select(colunas)
      .returns<Record<string, string | null>[]>()

    const porTexto = new Map<string, string[]>()
    for (const registro of data ?? []) {
      for (const coluna of ref.por) {
        const valor = registro[coluna]
        if (!valor) continue
        /* Documento casa por dígitos: `11.222.333/0001-44` e `11222333000144`
           são a mesma empresa, e comparar o texto cru criaria duas. */
        const chaves = /cnpj|cpf|document/i.test(coluna)
          ? [soDigitos(valor)]
          : [valor.trim().toLowerCase()]
        for (const k of chaves) {
          if (!k) continue
          porTexto.set(k, [...(porTexto.get(k) ?? []), registro.id as string])
        }
      }
    }

    for (const texto of procurados) {
      const alvos = [texto.trim().toLowerCase(), soDigitos(texto)].filter(Boolean)
      let achados: string[] | undefined
      for (const a of alvos) {
        const r = porTexto.get(a)
        if (r) {
          achados = r
          break
        }
      }
      const unicos = [...new Set(achados ?? [])]
      /* Três estados, e os três importam: achou (id), ambíguo (null) e NÃO
         ACHOU — que é a ausência da chave, não um `undefined` gravado. Gravar
         undefined apagaria a diferença entre "procurei e não há" e "nem
         procurei", e as duas pedem mensagens diferentes. */
      if (unicos.length === 1) {
        mapa.set(`${campo.nome}\u0000${texto.toLowerCase()}`, unicos[0])
      } else if (unicos.length > 1) {
        mapa.set(`${campo.nome}\u0000${texto.toLowerCase()}`, null)
      }
    }
  }
  return mapa
}

/** Quais chaves naturais do arquivo já existem no banco — e com qual id. */
async function buscarExistentes(
  supabase: Awaited<ReturnType<typeof createClient>>,
  recurso: RecursoDeImportacao,
  linhas: readonly LinhaConferida[],
  resolucao: ReadonlyMap<string, string | null>,
): Promise<Map<string, string>> {
  const chaves = camposChave(recurso)
  if (chaves.length === 0) return new Map()

  const colunas = ['id', ...chaves.map((c) => c.nome)].join(', ')
  /* Registro apagado não conta como existente: a chave dele está livre, e o
     índice único do banco já os ignora. Tratá-lo como existente faria a
     importação tentar ATUALIZAR um cadastro que a pessoa excluiu. */
  const consulta = recurso.temExclusaoLogica
    ? supabase.from(recurso.tabela).select(colunas).is('deleted_at', null)
    : supabase.from(recurso.tabela).select(colunas)
  const { data } = await consulta.returns<Record<string, unknown>[]>()

  const mapa = new Map<string, string>()
  for (const registro of data ?? []) {
    const partes = chaves.map((c) => {
      const v = registro[c.nome]
      if (v === null || v === undefined) return ''
      return /cnpj|cpf/i.test(c.nome) ? soDigitos(String(v)) : String(v).trim().toLowerCase()
    })
    if (partes.some((p) => p === '')) continue
    mapa.set(partes.join('\u0000'), registro.id as string)
  }

  /* As chaves do ARQUIVO que são referência vêm como texto; o mapa do banco tem
     id. Reescreve a chave do arquivo com o id resolvido para os dois casarem. */
  const comId = new Map<string, string>()
  for (const [k, v] of mapa) comId.set(k, v)
  for (const linha of linhas) {
    const partes: string[] = []
    let completa = true
    for (const c of chaves) {
      if (c.tipo === 'referencia') {
        const texto = linha.referencias[c.nome]
        const id = texto ? resolucao.get(`${c.nome}\u0000${texto.toLowerCase()}`) : undefined
        if (!id) {
          completa = false
          break
        }
        partes.push(id.toLowerCase())
      } else {
        const v = linha.valores[c.nome]
        if (v === undefined || v === null || v === '') {
          completa = false
          break
        }
        partes.push(/cnpj|cpf/i.test(c.nome) ? soDigitos(String(v)) : String(v).trim().toLowerCase())
      }
    }
    if (!completa) continue
    const doBanco = comId.get(partes.join('\u0000'))
    if (doBanco) {
      const doArquivo = chaveDaLinha(recurso, linha)
      if (doArquivo) comId.set(doArquivo, doBanco)
    }
  }
  return comId
}

/**
 * Aplica o lote: grava no negócio o que a prévia disse que ia gravar.
 *
 * As linhas recusadas não entram, e não impedem as outras. Recusar o arquivo
 * inteiro por causa de sete linhas obrigaria a pessoa a editar a planilha no
 * escuro e reenviar tudo — e é assim que uma importação de 300 clientes vira
 * três tentativas.
 */
export async function aplicarLote(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('sistema.planilhas.importar', {
    papel: 'config',
    mensagem: 'Sem permissão para aplicar importação.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const id = uuid.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data: lote } = await supabase
    .from('import_batches')
    .select('id, resource, status, on_conflict')
    .eq('id', id.data)
    .maybeSingle<{ id: string; resource: string; status: string; on_conflict: string }>()
  if (!lote) return { error: NAO_AFETADO }
  if (lote.status !== 'preview') return { error: 'Este lote já foi aplicado ou descartado.' }

  const recurso = recursoPorChave(lote.resource)
  if (!recurso) return { error: 'Recurso inválido.' }

  const doRecurso = await requirePermission(recurso.permissao)
  if ('error' in doRecurso) return doRecurso

  const { data: linhas } = await supabase
    .from('import_rows')
    .select('id, line_number, raw, outcome')
    .eq('batch_id', lote.id)
    .in('outcome', ['create', 'update'])
    .order('line_number')
    .returns<
      { id: string; line_number: number; outcome: 'create' | 'update'; raw: { valores: Record<string, unknown>; existente: string | null } }[]
    >()

  if (!linhas || linhas.length === 0) {
    await supabase.from('import_batches').update({ status: 'applied', applied_at: new Date().toISOString() }).eq('id', lote.id)
    revalida()
    return { success: 'Nada a aplicar: todas as linhas foram recusadas ou puladas.' }
  }

  let criadas = 0
  let atualizadas = 0
  const falhas: { id: string; motivo: string }[] = []

  for (const linha of linhas) {
    const valores = { ...linha.raw.valores, ...(recurso.padroes ?? {}) }

    if (linha.outcome === 'create') {
      const { data, error } = await supabase
        .from(recurso.tabela)
        .insert({ ...valores, tenant_id: profile.tenant_id })
        .select('id')
        .maybeSingle<{ id: string }>()
      if (error || !data) {
        falhas.push({ id: linha.id, motivo: error ? mensagemDeErro(error) : NAO_AFETADO })
        continue
      }
      criadas++
      await supabase.from('import_rows').update({ record_id: data.id }).eq('id', linha.id)
    } else {
      /* Na atualização, os campos de criação saem: o medidor inicial de um
         equipamento em operação não volta atrás, e a situação padrão não
         reescreve a situação real. */
      const paraAtualizar = { ...linha.raw.valores }
      for (const c of recurso.campos.filter((x) => x.somenteNaCriacao)) delete paraAtualizar[c.nome]

      const { data, error } = await supabase
        .from(recurso.tabela)
        .update(paraAtualizar)
        .eq('id', linha.raw.existente ?? '')
        .select('id')
      if (error || !data || data.length === 0) {
        falhas.push({ id: linha.id, motivo: error ? mensagemDeErro(error) : NAO_AFETADO })
        continue
      }
      atualizadas++
      await supabase.from('import_rows').update({ record_id: linha.raw.existente }).eq('id', linha.id)
    }
  }

  /* A linha que o banco recusou na hora de gravar VIRA RECUSA, com o motivo do
     banco. Marcá-la como aplicada diria que entrou algo que não entrou. */
  for (const f of falhas) {
    await supabase.from('import_rows').update({ outcome: 'reject', reason: f.motivo }).eq('id', f.id)
  }

  await supabase
    .from('import_batches')
    .update({ status: 'applied', applied_at: new Date().toISOString() })
    .eq('id', lote.id)

  revalida()
  revalidatePath('/clientes')
  revalidatePath('/inventario')
  revalidatePath('/locacao/pecas')
  revalidatePath('/locacao/frota')
  revalidatePath('/locacao/medicoes')

  const partes = [
    criadas > 0 ? `${criadas} criada(s)` : null,
    atualizadas > 0 ? `${atualizadas} atualizada(s)` : null,
    falhas.length > 0 ? `${falhas.length} recusada(s) pelo banco` : null,
  ].filter(Boolean)
  return { success: `Importação aplicada: ${partes.join(', ')}.` }
}

export async function descartarLote(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('sistema.planilhas.importar', {
    papel: 'config',
    mensagem: 'Sem permissão para descartar importação.',
  })
  if ('error' in gate) return gate

  const id = uuid.safeParse(formData.get('id'))
  if (!id.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('import_batches')
    .update({ status: 'discarded' })
    .eq('id', id.data)
    .eq('status', 'preview')
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) {
    return { error: 'Só uma prévia pode ser descartada — esta já foi aplicada.' }
  }

  revalida()
  return { success: 'Prévia descartada. Nada foi gravado.' }
}

/** Troca "o que fazer quando já existe" antes de aplicar. */
export async function trocarConflito(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('sistema.planilhas.importar', {
    papel: 'config',
    mensagem: 'Sem permissão para alterar a importação.',
  })
  if ('error' in gate) return gate

  const parsed = z
    .object({ id: uuid, conflito: z.enum(['update', 'skip']) })
    .safeParse({ id: formData.get('id'), conflito: formData.get('conflito') })
  if (!parsed.success) return { error: 'Registro inválido.' }

  const supabase = await createClient()
  const { data: lote } = await supabase
    .from('import_batches')
    .select('id, resource, status')
    .eq('id', parsed.data.id)
    .maybeSingle<{ id: string; resource: string; status: string }>()
  if (!lote) return { error: NAO_AFETADO }
  if (lote.status !== 'preview') return { error: 'Este lote já foi aplicado.' }

  const recurso = recursoPorChave(lote.resource)
  if (recurso?.somenteCriacao) {
    return { error: `${recurso.rotulo} não se atualiza: cada linha é um fato datado.` }
  }

  const novo = parsed.data.conflito === 'skip' ? 'skip' : 'update'
  await supabase.from('import_batches').update({ on_conflict: novo }).eq('id', lote.id)
  /* As linhas que apontavam para registro existente mudam de destino junto —
     senão a prévia mostraria "atualiza" para um lote que vai pular. */
  await supabase
    .from('import_rows')
    .update({ outcome: novo === 'skip' ? 'skip' : 'update' })
    .eq('batch_id', lote.id)
    .in('outcome', ['update', 'skip'])

  revalida()
  return {
    success:
      novo === 'skip'
        ? 'Linhas já existentes passam a ser puladas.'
        : 'Linhas já existentes passam a ser atualizadas.',
  }
}

/** Usado pela rota que baixa as recusadas. Mantém a sessão e o RLS. */
export async function sessaoDeImportacao() {
  return requireSession()
}
