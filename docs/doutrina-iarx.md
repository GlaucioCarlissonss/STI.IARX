# Doutrina IARX — padrões transferíveis

Anexo do `SYSTEM-PROMPT.md`. Aqui estão as formas concretas: estrutura, código
de referência e os portões, com o defeito que cada um nasceu para impedir.

**Escopo.** Nada aqui é regra de negócio de locação de equipamentos. O que
atravessa é arquitetura, verificação e padrões de interface. Onde um exemplo
precisa de domínio, ele é marcado como exemplo.

---

## 1. Forma do repositório

```
apps/
  api/            NestJS — rotas, serviços, repositórios
    src/banco/    conexão, contexto de transação, tradução de erro do Postgres
    src/comum/    erros de domínio, decoradores, envelope, paginação
    src/modulos/  um diretório por módulo: controller + service + repositorio
    test/         integração, contra banco real
  web/            React + Vite
    src/componentes/ui/   primitivos e componentes de lista
    src/lib/              hooks e utilidades sem JSX
    src/telas/            uma tela por arquivo
    src/dados/            fachada de acesso + base de demonstração
    test/                 unitários puros e portões de estrutura
    a11y.spec.mjs         axe, teclado, refluxo, e regras de domínio na tela
packages/
  contracts/      esquemas Zod + catálogo de permissões, sem dependência de UI
  db/
    supabase/migrations/  somente-avante, numeradas
    tests/                invariantes, em SQL, contra banco real
  tokens/         paleta como fonte única, CSS gerado por script
docs/
  anexos/         um anexo por assunto: modelo de dados, permissões, APIs…
```

**O que esta forma compra:** o catálogo de permissões vive num pacote sem
dependências, então front e API leem **o mesmo array**. Sem isso reaparece a
divergência clássica — o botão some na tela e a rota continua aberta, ou o
inverso, e ninguém percebe até alguém tentar.

**Scripts** (`package.json`), na ordem em que valem a pena rodar:

```
tipos          tsc nos três projetos
a11y:tokens    contraste WCAG 2.2 AA + distinção sob daltonismo
web:test       unitários e portões de estrutura
build          aplicação
a11y:dom       axe, teclado e refluxo no DOM renderizado
db:test        invariantes de banco
api:test       integração da API
verificar      todos, em sequência
```

---

## 2. Banco

### 2.1 Contexto de transação

```ts
// set_config(..., true) é SET LOCAL: morre no COMMIT/ROLLBACK.
// SET de sessão vazaria para a próxima requisição do mesmo pool —
// e o vazamento é de IDENTIDADE, não de performance.
await cliente.query(
  `select set_config('app.tenant_id',  $1, true),
          set_config('app.usuario_id', $2, true),
          set_config('app.request_id', $3, true)`,
  [claims.tenant_id, claims.usuario_id, ctx.requestId],
)
```

`set_config` e não `SET LOCAL x = '...'`: `SET` não aceita parâmetro, o que
obrigaria a concatenar valor no SQL.

### 2.2 RLS por tabela, aplicada por função

Uma função aplica o mesmo padrão a toda tabela, e o `do $$ ... $$` embaixo lista
quais recebem leitura de cliente:

```sql
alter table public.X enable row level security;
alter table public.X force row level security;   -- nem o dono escapa

create policy X_app on public.X for all to app_role
  using       (tenant_id = app.tenant_atual())
  with check  (tenant_id = app.tenant_atual());

revoke all on public.X from anon;                -- escrita nunca vai para anon
```

Quando a tabela precisa de recorte além do locatário — por dono, por exemplo —
a política é **estreitada**, e isso é propriedade da política, não da tela:

```sql
create policy visao_salva_app on public.visao_salva for all to app_role
  using (tenant_id = app.tenant_atual()
         and (compartilhada or dono_id = app.usuario_atual()));
```

### 2.3 Recusa com nome

```sql
if v_n > 0 then
  raise exception 'equipamento com % alocação(ões) vigente(s) não é baixado', v_n
    using errcode    = '23514',
          constraint = 'equipamento_alocado_nao_baixa',
          hint       = 'Encerre os itens de contrato antes da baixa.';
end if;
```

E na API, uma tabela que traduz:

```ts
const POR_CONSTRAINT: Record<string, () => ErroDominio> = {
  equipamento_alocado_nao_baixa: () =>
    new ErroDominio('REGRA_DE_NEGOCIO', 'Equipamento alocado em contrato', {
      detail: 'Com item de contrato vigente, a máquina continua no cliente.',
      acoes: [{ code: 'ENCERRAR_ITEM', descricao: 'Encerrar o item do contrato' }],
    }),
}
```

O nome da constraint é a costura entre o gatilho e a mensagem. Sem ele, quem
depura vê "violação de check" e nada mais.

### 2.4 Armadilhas de PL/pgSQL que custaram caro aqui

- **Coluna gerada é nula em gatilho `BEFORE`.** O Postgres a calcula depois. Um
  guarda que lia `custo_total` passava em todo lugar, parecendo instalado.
  Some as parcelas.
- **Gatilhos `BEFORE` do mesmo evento disparam em ordem alfabética do nome.**
  Se um depende do outro, o nome é que ordena.
- **Variável `record` declarada sombreia alias de tabela de mesmo nome.**
- **`%` em `raise`** é placeholder: uma mensagem com percentual literal precisa
  de `%%`, e `%%%%` dá "too many parameters".
- **`COALESCE` entre `text` e enum** não compila: tipifique o parâmetro
  (`$2::app.meu_enum`).

### 2.5 Teste de banco

Um arquivo por assunto, numerado. Cada caso abre transação, define o contexto,
tenta o que deve ser recusado e **afirma o nome da constraint**:

```sql
begin;
  set local app.tenant_id  = :'t1';
  set local app.usuario_id = :'tec';
  do $$
  declare v_constraint text;
  begin
    begin
      insert into public.visao_salva (..., compartilhada) values (..., true);
      raise exception 'FALHA: publicou sem a permissão';
    exception when sqlstate '23514' then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'visao_compartilhar_sem_permissao' then
        raise exception 'FALHA: recusou por "%"', v_constraint;
      end if;
    end;
    raise notice 'caso 3 OK — publicar exige permissão, e a recusa é na escrita';
  end $$;
commit;
```

Por que a recusa é na **escrita** e não na leitura: se a conferência vivesse só
na política de leitura, o `UPDATE` passaria, a linha ficaria publicada, e o erro
apareceria — como ausência — para quem tentasse ler, nunca para quem o cometeu.

---

## 3. API

### 3.1 Controlador

```ts
@Controller('api/v1/visoes')
export class VisoesController {
  @Get()
  @ExigePermissao('visao:ler')
  listar(@Query(validar(ListarVisoes)) filtro: ListarVisoes) { ... }

  @Post()
  @HttpCode(201)
  @ExigePermissao('visao:gerenciar')
  criar(@Body(validar(CriarVisao)) corpo: CriarVisao) { ... }
}
```

Toda rota declara permissão. **Não existe "rota sem permissão"** — o guarda
recusa antes de olhar o token. Quando a regra depende do **corpo** e não do
caminho (criar um registro privado e publicá-lo para todos entram pelo mesmo
`POST`), a permissão fina é conferida no banco, e a ausência de rota é
registrada por escrito no portão de cobertura.

### 3.2 Repositório

Sem `where tenant_id` — quem isola é a RLS. Repetir o filtro dá a impressão de
que o isolamento é da camada de acesso, e no dia em que alguém escrever uma
consulta sem lembrar dele a falha é silenciosa.

Alteração parcial com `coalesce` por campo, e **nunca** `set` montado
dinamicamente a partir das chaves do corpo:

```sql
update public.visao_salva
   set nome     = coalesce(btrim($2), nome),
       consulta = coalesce($3::jsonb, consulta),
       version  = version + 1
 where id = $1
 returning id
```

### 3.3 Erro de domínio

Um tipo que **não** estende a exceção HTTP do framework: o domínio não conhece
o transporte, e um filtro traduz. O status por código é centralizado, senão o
mesmo código sai 409 numa rota e 422 noutra, e o cliente que trata por `code`
acaba tendo de tratar por status também.

---

## 4. Front-end

### 4.1 Tabela com seleção e paginação

Props relevantes do componente único de lista:

```ts
interface TabelaProps<T> {
  colunas: Coluna<T>[]
  itens: T[]
  chaveDe: (item: T) => string
  porPagina?: number
  selecao?: {
    selecionados: ReadonlySet<string>
    aoMudar: (ids: string[]) => void
    rotuloDe: (item: T) => string
    impedimentoDe?: (item: T) => string | undefined
  }
}
```

Decisões embutidas:

- a caixa do cabeçalho precisa de `indeterminate` **posto por efeito** —
  o estado "alguns" não existe como atributo em HTML;
- paginar esvazia a seleção, e o rodapé diz quantos estão marcados **nesta
  página**;
- o rodapé aparece sempre que há paginação, mesmo com uma página só: antes era
  "página 1 de 18" no cabeçalho com os controles fora da dobra — paginação
  declarada e não oferecida.

### 4.2 Menu de ações da linha

Padrão *Actions Menu Button* do APG. O que não é óbvio:

- `<select>` é escolha de valor, não disparo de ação; `<details>` não tem
  semântica de menu;
- Esc fecha **e devolve o foco ao gatilho**;
- o menu é desenhado em `document.body` por portal, porque o contêiner da
  tabela tem `overflow-x: auto` — e **em CSS, um eixo `auto` com o outro
  `visible` torna os dois `auto`**: o menu era recortado em cima e embaixo;
- fechar em qualquer evento de rolagem é errado: clicar no gatilho dá foco a
  ele, o navegador rola o contêiner para trazê-lo à vista, e o menu fechava no
  mesmo gesto que o abriu. **Remeça a posição** e feche só quando o gatilho sai
  da viewport;
- o foco no primeiro item vai num efeito **separado**, que depende da posição
  já medida: no mesmo efeito o portal ainda não montou.

### 4.3 Execução em lote

```ts
export async function executarLote(
  alvos: { id: string; rotulo: string; impedimento?: string }[],
  acao: (id: string) => Promise<Resultado<unknown>>,
  aoProgredir?: (feitos: number, total: number) => void,
): Promise<{ concluidos: string[]; recusados: Falha[]; ignorados: Falha[] }>
```

- **em série**, porque em paralelo a ordem do relato depende de qual promessa
  resolve primeiro, e ninguém encontra o registro que falhou;
- **exceção numa linha não interrompe as demais**: parar na terceira de vinte
  deixaria dezessete sem tentativa e sem registro de que não foram tentadas;
- três desfechos distintos, e a interface não os mistura.

### 4.4 Filtro na URL

```ts
const PADROES = { q: '', estado: '', categoria: '' }   // fora do componente
const filtro = useFiltroNaUrl(PADROES)
```

- declarado **fora** do componente: dentro, seria objeto novo a cada render e
  todo `useMemo` que depende dele recalcularia;
- valor igual ao padrão **sai** da URL, senão dois recortes iguais produzem
  endereços diferentes;
- `replace`, nunca `push`: cada tecla digitada viraria uma entrada no histórico;
- aplicar um recorte salvo **descarta** parâmetros que não são filtro desta
  tela, senão a lista mostra o recorte certo com o endereço errado.

### 4.5 Navegação

- acordeão por área, **várias abertas ao mesmo tempo** — sanfona não é rádio;
- a área da tela atual abre sozinha e não fecha por navegação: quem chega por
  link precisa ver onde está;
- **uma seta só, que gira.** Dois símbolos obrigam a comparar de memória com o
  estado esperado; a seta girando mostra o estado *e* a transição, e com
  movimento reduzido ela aparece já girada;
- em celular, barra inferior com 4–5 destinos **rotulados** e um "Mais".

---

## 5. Os portões, com o defeito de cada um

| Portão | Nasceu de |
| --- | --- |
| **Tokens de CSS declarados** | oito declarações usavam variáveis inexistentes. `color: var(--inexistente)` **não é erro**: a declaração inteira é descartada e a propriedade herda. Telas ficaram meses com cor e tamanho errados e nada acusou — o `axe` aprovava porque a cor herdada, por acaso, tinha contraste |
| **Estados de tela** | 19 de 24 telas com consulta não tratavam erro: renderizavam `dado ?? []` e a tabela anunciava "nenhum registro". Uma delas guardava com `if (carregando \|\| !dado)` e ficava no esqueleto **para sempre** |
| **Superfície de módulo** | `export` sem consumidor é API pública que ninguém pediu e que ninguém pode mudar sem medo. A lista de exceções exige **razão escrita** |
| **Cobertura de rotas** | permissão sem rota não quebra nada — e por isso fica anos no catálogo parecendo implementada |
| **Árvore de permissões** | permissão sem lugar na árvore é permissão que a tela de configuração não mostra, e que portanto ninguém consegue conceder |
| **Matriz de permissões** | o perfil-semente do código tem de bater com a matriz documentada, campo a campo, nos dois sentidos (faltando **e** sobrando) |
| **`service_role` ausente** | a chave que ignora RLS, num bundle de frontend, apaga o isolamento entre locatários de forma silenciosa |
| **Contexto só por `SET LOCAL`** | `SET` de sessão vaza identidade para a próxima requisição do pool |
| **Refluxo em 320px** | cada barra nova empurra a página para a rolagem lateral; o portão mede `scrollWidth > clientWidth` |

**Guarda contra vacuidade**, em todo portão que varre arquivos:

```ts
assert.ok(declarantes.length >= 100, `só ${declarantes.length} arquivos: o caminho mudou?`)
```

Sem ela, renomear um diretório faz o portão passar por não encontrar nada.

### A armadilha do `axe` com animação

A suíte reprovava contraste de `#808892` sobre `#fdfdfe` — cores que **não
existem em nenhum frame parado**: era o cinza correto misturado com o branco de
trás, no meio de um fade de entrada. A rotina que estabiliza a página passou a
esperar as animações finitas:

```js
await page.evaluate(() => Promise.all(
  document.getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity)  // o esqueleto nunca termina
    .map((a) => a.finished.catch(() => {})),
))
```

---

## 6. Base de demonstração que não mente

O front serve uma base em memória com a **mesma assinatura** que uma API HTTP
teria — assíncrona, com latência e possibilidade de erro. Isso permite exibir
esqueleto de carregamento de verdade em vez de simulá-lo, e trocar por `fetch`
sem mexer em nenhuma tela.

Duas regras que parecem detalhe e não são:

- **cada leitura devolve coleção nova**, não a referência interna. Devolvendo a
  mesma, `useMemo([dado])` vê a mesma identidade e não recalcula: a lista
  continuaria exibindo o estado anterior à ação, mesmo tendo sido "recarregada";
- as regras reimplementadas aqui usam o **mesmo nome** das do banco, e é por
  esse nome que se percebe que uma das duas cópias mudou sozinha.

Afordâncias que só existem na demonstração — um seletor que troca o próprio
perfil, por exemplo — ficam atrás de uma detecção explícita de modo
demonstração, nunca expostas como produção.

---

## 7. Checklist de fase

Antes de começar:

- [ ] a modelagem está escrita, com os invariantes nomeados?
- [ ] cada rota nova tem permissão declarada e justificada?
- [ ] há protótipo aprovado, se a fase mexe em interface?
- [ ] os casos de teste da fase foram escritos **antes** do código?

Antes de dizer pronto:

- [ ] todos os portões verdes, com os números no relato?
- [ ] cada recusa nova tem nome, mensagem e saída sugerida?
- [ ] as lacunas e decisões pendentes estão ditas, não omitidas?
- [ ] alguma regra ficou duplicada em vez de unificada?
- [ ] alguma verificação mede proxy em vez do fato?
