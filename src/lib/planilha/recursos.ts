import type { Esfera } from '@/lib/esferas'

/**
 * O que pode ser importado, e sob quais regras.
 *
 * ## Por que um catálogo, e não um importador por tela
 *
 * A alternativa seria um botão "importar" dentro de Clientes, outro dentro de
 * Ativos, e assim por diante. Cada um teria a própria validação, a própria
 * ideia de chave e o próprio jeito de recusar — e em três meses dois deles
 * discordariam sobre o que fazer quando a linha já existe.
 *
 * Aqui a regra é uma só e o que varia é DADO: campos, chave natural e
 * validação. O GSTI fazia igual no grupo *Sistema*, e por isso o ciclo de lá
 * cabe aqui sem virar cinco telas.
 *
 * ## O que NÃO está neste catálogo, de propósito
 *
 * Títulos a pagar e a receber. Errar num cadastro cria um registro errado que
 * alguém corrige; errar num título cria **cobrança indevida** — e uma planilha
 * de 300 linhas cria 300. Quando entrar, entra com conferência mais dura
 * (soma do arquivo conferida contra a soma esperada, aprovação de quem tem
 * alçada), e isso é uma fase, não uma linha neste arquivo.
 */

export type TipoDeCampo = 'texto' | 'numero' | 'inteiro' | 'data' | 'booleano' | 'opcao' | 'referencia'

export interface OpcaoDeCampo {
  /** O que vai para o banco. */
  valor: string
  /** Como a planilha pode escrever — a primeira é o rótulo que exportamos. */
  rotulos: readonly string[]
}

export interface ReferenciaDeCampo {
  /** Tabela onde procurar. */
  tabela: string
  /** Colunas pelas quais a planilha pode identificar o registro. */
  por: readonly string[]
  /** Como chamar isso no erro: "cliente", "modelo", "depósito". */
  nome: string
  /** Comparar sem caixa (nome de modelo, patrimônio). */
  ignorarCaixa?: boolean
}

export interface CampoDeImportacao {
  /** Coluna no banco. */
  nome: string
  /** Cabeçalho em português — é o que a exportação escreve e o que casa. */
  titulo: string
  sinonimos?: readonly string[]
  tipo: TipoDeCampo
  obrigatorio?: boolean
  /** Compõe a chave natural: é o que decide criar, atualizar ou pular. */
  chave?: boolean
  /** Só na criação — mudar isto num registro existente seria outra coisa. */
  somenteNaCriacao?: boolean
  opcoes?: readonly OpcaoDeCampo[]
  referencia?: ReferenciaDeCampo
  max?: number
  /** Dica curta, mostrada no passo de casar colunas. */
  ajuda?: string
}

export interface RecursoDeImportacao {
  chave: string
  rotulo: string
  descricao: string
  /** Módulo, para a esfera: um locador não importa ativo de TI. */
  modulo: string
  /** A MESMA chave da tela de destino: quem não pode cadastrar à mão não
      cadastra em lote. O importador não amplia o que a pessoa pode. */
  permissao: string
  tabela: string
  campos: readonly CampoDeImportacao[]
  /** Colunas fixas em toda linha criada. */
  padroes?: Readonly<Record<string, unknown>>
  /** Recurso que não atualiza: a chave existir significa pular, sempre. */
  somenteCriacao?: boolean
  /** A tabela tem `deleted_at`: o apagado não disputa a chave. */
  temExclusaoLogica?: boolean
  esferas?: readonly Esfera[]
}

const SIM_NAO: readonly OpcaoDeCampo[] = [
  { valor: 'true', rotulos: ['sim', 'true', 'verdadeiro', '1', 'x'] },
  { valor: 'false', rotulos: ['não', 'nao', 'false', 'falso', '0', ''] },
]

export const RECURSOS: readonly RecursoDeImportacao[] = [
  {
    chave: 'clientes',
    rotulo: 'Clientes',
    descricao: 'Razão social, nome fantasia e CNPJ. O CNPJ é a chave.',
    modulo: 'clientes',
    /* `grupos` é como o catálogo chama a tabela `clients` desde a 0017 — o
       cadastro de cliente/grupo econômico. Inventar `clientes.clientes.criar`
       aqui criaria uma chave que não governa nada. */
    permissao: 'clientes.grupos.criar',
    tabela: 'clients',
    temExclusaoLogica: true,
    padroes: { status: 'active' },
    campos: [
      {
        nome: 'cnpj',
        titulo: 'CNPJ',
        tipo: 'texto',
        chave: true,
        obrigatorio: true,
        max: 20,
        ajuda: 'Decide se a linha cria ou atualiza. Com ou sem pontuação.',
      },
      { nome: 'legal_name', titulo: 'Razão social', sinonimos: ['razao social', 'cliente', 'nome'], tipo: 'texto', obrigatorio: true, max: 160 },
      { nome: 'trade_name', titulo: 'Nome fantasia', sinonimos: ['fantasia'], tipo: 'texto', max: 120 },
      { nome: 'contract_ref', titulo: 'Contrato', sinonimos: ['referencia do contrato'], tipo: 'texto', max: 60 },
      {
        nome: 'status',
        titulo: 'Situação',
        tipo: 'opcao',
        opcoes: [
          { valor: 'active', rotulos: ['ativo', 'active'] },
          { valor: 'inactive', rotulos: ['inativo', 'inactive'] },
          { valor: 'prospect', rotulos: ['prospecto', 'prospect'] },
        ],
      },
      { nome: 'notes', titulo: 'Observações', tipo: 'texto', max: 2000 },
    ],
  },

  {
    chave: 'filiais',
    rotulo: 'Filiais',
    descricao: 'Filiais de clientes já cadastrados. A chave é cliente + código.',
    modulo: 'clientes',
    permissao: 'clientes.filiais.criar',
    tabela: 'branches',
    temExclusaoLogica: true,
    campos: [
      {
        nome: 'client_id',
        titulo: 'Cliente',
        sinonimos: ['cnpj do cliente', 'razao social'],
        tipo: 'referencia',
        obrigatorio: true,
        chave: true,
        referencia: { tabela: 'clients', por: ['cnpj', 'legal_name', 'trade_name'], nome: 'cliente' },
        ajuda: 'CNPJ ou razão social de um cliente que já exista.',
      },
      {
        nome: 'code',
        titulo: 'Código',
        tipo: 'texto',
        obrigatorio: true,
        chave: true,
        max: 20,
        ajuda: 'Único dentro do cliente — é a segunda metade da chave.',
      },
      { nome: 'name', titulo: 'Filial', sinonimos: ['nome'], tipo: 'texto', obrigatorio: true, max: 120 },
      { nome: 'cnpj', titulo: 'CNPJ da filial', tipo: 'texto', max: 20 },
      { nome: 'address_line', titulo: 'Endereço', sinonimos: ['logradouro'], tipo: 'texto', max: 200 },
      { nome: 'district', titulo: 'Bairro', tipo: 'texto', max: 80 },
      { nome: 'city', titulo: 'Cidade', tipo: 'texto', max: 80 },
      { nome: 'state', titulo: 'UF', sinonimos: ['estado'], tipo: 'texto', max: 2 },
      { nome: 'postal_code', titulo: 'CEP', tipo: 'texto', max: 12 },
      { nome: 'contact_name', titulo: 'Contato', tipo: 'texto', max: 120 },
      { nome: 'contact_email', titulo: 'E-mail do contato', tipo: 'texto', max: 160 },
      { nome: 'contact_phone', titulo: 'Telefone do contato', tipo: 'texto', max: 40 },
      { nome: 'is_active', titulo: 'Ativa', tipo: 'booleano', opcoes: SIM_NAO },
    ],
  },

  {
    chave: 'ativos',
    rotulo: 'Ativos de TI',
    descricao: 'Parque de equipamentos. A chave é o patrimônio.',
    modulo: 'inventario',
    permissao: 'inventario.ativos.criar',
    tabela: 'it_assets',
    temExclusaoLogica: true,
    esferas: ['management'],
    padroes: { status: 'in_stock' },
    campos: [
      { nome: 'asset_tag', titulo: 'Patrimônio', sinonimos: ['tag', 'etiqueta'], tipo: 'texto', obrigatorio: true, chave: true, max: 40 },
      {
        nome: 'asset_type',
        titulo: 'Tipo',
        tipo: 'opcao',
        obrigatorio: true,
        opcoes: [
          { valor: 'notebook', rotulos: ['notebook', 'laptop'] },
          { valor: 'desktop', rotulos: ['desktop', 'computador'] },
          { valor: 'server', rotulos: ['servidor', 'server'] },
          { valor: 'smartphone', rotulos: ['smartphone', 'celular'] },
          { valor: 'tablet', rotulos: ['tablet'] },
          { valor: 'monitor', rotulos: ['monitor'] },
          { valor: 'printer', rotulos: ['impressora', 'printer'] },
          { valor: 'peripheral', rotulos: ['periférico', 'periferico'] },
          { valor: 'network', rotulos: ['rede', 'network'] },
          { valor: 'software_license', rotulos: ['licença', 'licenca', 'software'] },
          { valor: 'other', rotulos: ['outro', 'other'] },
        ],
      },
      { nome: 'serial_number', titulo: 'Número de série', sinonimos: ['serial'], tipo: 'texto', max: 80 },
      { nome: 'brand', titulo: 'Marca', sinonimos: ['fabricante'], tipo: 'texto', max: 60 },
      { nome: 'model', titulo: 'Modelo', tipo: 'texto', max: 80 },
      {
        nome: 'branch_id',
        titulo: 'Filial',
        tipo: 'referencia',
        referencia: { tabela: 'branches', por: ['name', 'code'], nome: 'filial' },
      },
      {
        nome: 'status',
        titulo: 'Situação',
        tipo: 'opcao',
        opcoes: [
          { valor: 'in_stock', rotulos: ['em estoque', 'estoque'] },
          { valor: 'active', rotulos: ['em uso', 'ativo'] },
          { valor: 'maintenance', rotulos: ['manutenção', 'manutencao'] },
          { valor: 'retired', rotulos: ['baixado', 'descartado'] },
          { valor: 'lost', rotulos: ['extraviado', 'perdido'] },
        ],
      },
      { nome: 'acquisition_date', titulo: 'Data de aquisição', sinonimos: ['compra'], tipo: 'data' },
      { nome: 'warranty_until', titulo: 'Garantia até', sinonimos: ['garantia'], tipo: 'data' },
      { nome: 'acquisition_cost', titulo: 'Valor de aquisição', sinonimos: ['valor'], tipo: 'numero' },
      { nome: 'notes', titulo: 'Observações', tipo: 'texto', max: 2000 },
    ],
  },

  {
    chave: 'pecas',
    rotulo: 'Peças',
    descricao: 'Catálogo de peças. A chave é o SKU. O saldo NÃO entra aqui.',
    modulo: 'locacao',
    permissao: 'locacao.pecas.gerenciar',
    tabela: 'parts',
    temExclusaoLogica: true,
    esferas: ['rental'],
    campos: [
      { nome: 'sku', titulo: 'Código', sinonimos: ['sku'], tipo: 'texto', obrigatorio: true, chave: true, max: 40 },
      { nome: 'name', titulo: 'Peça', sinonimos: ['nome', 'descricao'], tipo: 'texto', obrigatorio: true, max: 160 },
      {
        nome: 'unit',
        titulo: 'Unidade',
        tipo: 'opcao',
        opcoes: [
          { valor: 'un', rotulos: ['un', 'unidade', 'peça', 'peca'] },
          { valor: 'par', rotulos: ['par'] },
          { valor: 'm', rotulos: ['m', 'metro'] },
          { valor: 'kg', rotulos: ['kg', 'quilo'] },
          { valor: 'l', rotulos: ['l', 'litro'] },
          { valor: 'cx', rotulos: ['cx', 'caixa'] },
        ],
      },
      { nome: 'category', titulo: 'Categoria', tipo: 'texto', max: 60 },
      { nome: 'notes', titulo: 'Observações', tipo: 'texto', max: 2000 },
      { nome: 'is_active', titulo: 'Ativa', tipo: 'booleano', opcoes: SIM_NAO },
    ],
  },

  {
    chave: 'frota',
    rotulo: 'Equipamentos de frota',
    descricao: 'Equipamento próprio para locar. A chave é o patrimônio.',
    modulo: 'locacao',
    permissao: 'locacao.frota.criar',
    tabela: 'rental_equipment',
    temExclusaoLogica: true,
    esferas: ['rental'],
    padroes: { status: 'available' },
    campos: [
      { nome: 'asset_tag', titulo: 'Patrimônio', sinonimos: ['tag'], tipo: 'texto', obrigatorio: true, chave: true, max: 40 },
      {
        nome: 'model_id',
        titulo: 'Modelo',
        tipo: 'referencia',
        obrigatorio: true,
        referencia: { tabela: 'equipment_models', por: ['name', 'code'], nome: 'modelo', ignorarCaixa: true },
        ajuda: 'Nome ou código de um modelo já cadastrado.',
      },
      { nome: 'serial_number', titulo: 'Número de série', sinonimos: ['serial'], tipo: 'texto', max: 80 },
      {
        nome: 'depot_id',
        titulo: 'Depósito',
        tipo: 'referencia',
        referencia: { tabela: 'rental_depots', por: ['name', 'code'], nome: 'depósito', ignorarCaixa: true },
      },
      /* O medidor inicial só na CRIAÇÃO. Reimportar a planilha com a leitura
         antiga faria o horímetro de uma máquina em operação andar para trás —
         e o cálculo da fatura leria consumo negativo. */
      { nome: 'meter_reading', titulo: 'Leitura inicial', sinonimos: ['horimetro', 'medidor'], tipo: 'numero', somenteNaCriacao: true },
      { nome: 'acquisition_date', titulo: 'Data de aquisição', tipo: 'data' },
      { nome: 'acquisition_value', titulo: 'Valor de aquisição', sinonimos: ['valor'], tipo: 'numero' },
      { nome: 'invoice_ref', titulo: 'Nota fiscal', sinonimos: ['nf'], tipo: 'texto', max: 60 },
      { nome: 'useful_life_months', titulo: 'Vida útil (meses)', tipo: 'inteiro' },
      { nome: 'notes', titulo: 'Observações', tipo: 'texto', max: 2000 },
    ],
  },

  {
    chave: 'leituras',
    rotulo: 'Leituras de medidor',
    descricao:
      'Leitura por equipamento e data. Mil leituras por mês não se digitam — é o recurso de maior volume.',
    modulo: 'locacao',
    permissao: 'locacao.medicoes.lancar',
    tabela: 'meter_readings',
    esferas: ['rental'],
    /* `source: 'import'` distingue no histórico o que veio de planilha do que
       foi digitado ou registrado na entrega. Sem isso, "de onde saiu esta
       leitura?" não tem resposta. */
    padroes: { source: 'import' },
    /*
     * Leitura não se ATUALIZA: cada linha é um fato datado.
     *
     * Reimportar o mesmo arquivo encontra a chave e PULA. Deixar atualizar
     * permitiria reescrever o passado — e o consumo de um mês fechado mudaria
     * depois de a fatura já ter sido emitida.
     */
    somenteCriacao: true,
    campos: [
      {
        nome: 'equipment_id',
        titulo: 'Patrimônio',
        sinonimos: ['equipamento', 'tag'],
        tipo: 'referencia',
        obrigatorio: true,
        chave: true,
        referencia: { tabela: 'rental_equipment', por: ['asset_tag', 'serial_number'], nome: 'equipamento', ignorarCaixa: true },
      },
      { nome: 'read_on', titulo: 'Data da leitura', sinonimos: ['data'], tipo: 'data', obrigatorio: true, chave: true },
      { nome: 'reading', titulo: 'Leitura', sinonimos: ['medidor', 'horimetro', 'contador'], tipo: 'numero', obrigatorio: true },
      { nome: 'notes', titulo: 'Observações', tipo: 'texto', max: 500 },
    ],
  },
]

export function recursoPorChave(chave: string): RecursoDeImportacao | undefined {
  return RECURSOS.find((r) => r.chave === chave)
}

/** Os recursos que esta empresa pode importar, pela esfera. */
export function recursosNaEsfera(esferas: readonly Esfera[]): RecursoDeImportacao[] {
  return RECURSOS.filter((r) => !r.esferas || r.esferas.some((e) => esferas.includes(e)))
}

/** Os campos que compõem a chave natural, na ordem declarada. */
export function camposChave(recurso: RecursoDeImportacao): CampoDeImportacao[] {
  return recurso.campos.filter((c) => c.chave)
}

/**
 * O modelo de planilha: só o cabeçalho, na ordem dos campos.
 *
 * Existe porque "qual o formato?" é a primeira pergunta de quem vai importar, e
 * a resposta honesta é um arquivo, não um parágrafo de ajuda.
 */
export function cabecalhoModelo(recurso: RecursoDeImportacao): string[] {
  return recurso.campos.map((c) => c.titulo)
}
