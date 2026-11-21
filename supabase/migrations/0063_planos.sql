-- =============================================================================
-- 0063 — Planos
-- =============================================================================
-- Fecha o último item do pedido original da entrada pública: "ver os planos".
--
-- A 0062 fez `tenants.status` valer e criou `tenants.plano_id` sem o catálogo
-- do outro lado. Esta migração traz o catálogo.
--
-- ## O catálogo é da PLATAFORMA, não de cada empresa
--
-- Por isso `planos` não tem `tenant_id` — é a mesma natureza de
-- `platform_settings` e `permission_catalog`. Uma empresa não inventa o próprio
-- plano; ela escolhe um dos que existem.
--
-- Consequência de RLS: qualquer pessoa autenticada LÊ o catálogo, e ninguém o
-- escreve pela aplicação. Esconder os planos de quem já é cliente não protege
-- nada — eles estão na página pública — e só impediria a tela de assinatura de
-- dizer em qual plano a empresa está.
--
-- ## O preço fica aqui, e a COBRANÇA não
--
-- Este sistema não emite boleto, não integra adquirente e não guarda cartão.
-- O preço existe para a página pública dizer quanto custa e para a assinatura
-- mostrar o que foi contratado. Quem cobra é quem vende, por fora.
--
-- Prometer cobrança integrada com um campo de preço seria prometer o que não
-- existe — e o primeiro cliente descobriria no primeiro vencimento.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. O catálogo
-- -----------------------------------------------------------------------------
create table public.planos (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null unique,
  nome          text not null,
  resumo        text not null,

  /* `numeric`, e não centavos inteiros: é a convenção desta base inteira, e o
     `numeric` do PostgreSQL é decimal exato — o defeito que "centavos inteiros"
     evita (ponto flutuante perdendo centavo no rateio) não existe aqui.
     Ver a divergência declarada em CLAUDE.md. */
  preco_mensal  numeric(14,2) check (preco_mensal is null or preco_mensal >= 0),

  /* `null` = sem teto. Zero seria "nenhum usuário", que é outra coisa — e a
     diferença entre as duas aparece no dia em que alguém tenta convidar o
     décimo primeiro. */
  limite_usuarios integer check (limite_usuarios is null or limite_usuarios > 0),
  limite_chamados_mes integer check (limite_chamados_mes is null or limite_chamados_mes > 0),

  /* Quais esferas o plano habilita. Um plano só de gestão não dá acesso às
     telas de locação — e essa é a mesma pergunta que `tenants.spheres`
     responde, só que do lado de quem vende. */
  esferas       text[] not null default array['management']
                check (esferas <@ array['management','rental'] and array_length(esferas,1) > 0),

  /* O que a página pública lista em bullets. Texto livre porque é material de
     venda: amarrar isso a uma tabela de recursos faria cada ajuste de marketing
     virar migração. */
  destaques     text[] not null default '{}',

  publico       boolean not null default true,
  ordem         smallint not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.planos is
  'Catálogo da plataforma. Sem tenant_id: a empresa escolhe um, não inventa o seu.';

create index idx_planos_publicos on public.planos (ordem) where publico and is_active;

create trigger trg_planos_touch
  before update on public.planos
  for each row execute function app.touch_updated_at();

-- Agora a chave estrangeira que a 0062 deixou pendente, de propósito: a coluna
-- nasceu lá para a view não precisar ser reescrita, e a referência só podia
-- existir depois da tabela.
alter table public.tenants
  add constraint tenants_plano_id_fkey
  foreign key (plano_id) references public.planos(id) on delete set null;

-- -----------------------------------------------------------------------------
-- 2. RLS: todo mundo lê, ninguém escreve pela aplicação
-- -----------------------------------------------------------------------------
alter table public.planos enable row level security;
alter table public.planos force row level security;

/*
 * Sem `tenant_id` na condição, de propósito: o catálogo é global. É a mesma
 * decisão de `permission_catalog`, e pelo mesmo motivo — recortar por empresa
 * um dado que é da plataforma criaria a ilusão de isolamento onde não há nada
 * a isolar.
 */
create policy planos_select on public.planos
  for select to authenticated
  using (is_active);

grant select on public.planos to authenticated;
grant select, insert, update on public.planos to service_role;

-- -----------------------------------------------------------------------------
-- 3. A leitura pública, sem sessão
-- -----------------------------------------------------------------------------
/*
 * A página `/planos` é vista por quem ainda NÃO tem conta — é dela que sai a
 * decisão de criar uma. Então a leitura não pode exigir sessão.
 *
 * `security definer` com filtro fixo: devolve só o que é público e ativo, e só
 * as colunas que a página mostra. Dar `select` direto ao papel `anon` abriria a
 * tabela inteira, incluindo planos que ainda não foram anunciados.
 */
create or replace function public.planos_publicos()
returns table (
  codigo text,
  nome text,
  resumo text,
  preco_mensal numeric,
  limite_usuarios integer,
  limite_chamados_mes integer,
  esferas text[],
  destaques text[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.codigo, p.nome, p.resumo, p.preco_mensal,
         p.limite_usuarios, p.limite_chamados_mes, p.esferas, p.destaques
    from public.planos p
   where p.publico and p.is_active
   order by p.ordem, p.preco_mensal nulls last;
$$;

grant execute on function public.planos_publicos() to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Os planos de partida
-- -----------------------------------------------------------------------------
/*
 * Três, e os preços são de PARTIDA — quem publica ajusta na própria instalação.
 * Deixar a tabela vazia faria a página pública nascer sem nada para mostrar, e
 * "nenhum plano cadastrado" na primeira visita de um prospecto é pior que um
 * preço que será revisado.
 *
 * A escala é por ESFERA e por tamanho, não por recurso: recortar funcionalidade
 * para forçar a subida de plano produz o sistema que esta base passou a entrega
 * inteira evitando — tela que existe e não funciona.
 */
insert into public.planos (codigo, nome, resumo, preco_mensal, limite_usuarios,
                           limite_chamados_mes, esferas, destaques, ordem) values
  ('essencial', 'Essencial',
   'Para a equipe de TI que atende uma empresa e quer parar de usar planilha.',
   249.00, 10, 500, array['management'],
   array[
     'Chamados com SLA em horário útil',
     'Inventário de TI com agente nas máquinas',
     'Base de conhecimento e catálogo de serviços',
     'Portal de autoatendimento',
     'Pesquisa de satisfação'
   ], 1),

  ('gestao', 'Gestão',
   'Para quem responde pelo orçamento de TI, e não só pelo atendimento.',
   549.00, 40, null, array['management'],
   array[
     'Tudo do Essencial, sem limite de chamados',
     'Financeiro: títulos, contas, centros de custo e fluxo de caixa',
     'Orçamento de TI com previsto contra realizado',
     'Projetos e visão de resultado por cliente',
     'Conversas por WhatsApp e Telegram',
     'Sugestões de IA'
   ], 2),

  ('locacao', 'Locação',
   'Para quem aluga equipamento próprio e fatura por contrato e medição.',
   890.00, null, null, array['management','rental'],
   array[
     'Tudo da Gestão',
     'Frota com ciclo de vida e histórico por equipamento',
     'Contratos, medições e faturamento com excedente de medidor',
     'Manutenção em campo com apontamento de horas e peças',
     'Peças, estoque, ordens de compra e contagens',
     'Sem limite de usuários'
   ], 3)
on conflict (codigo) do nothing;

-- -----------------------------------------------------------------------------
-- 5. A empresa em avaliação nasce apontando para um plano
-- -----------------------------------------------------------------------------
/*
 * Sem isto, a tela de assinatura de quem acabou de se cadastrar diria "plano:
 * nenhum" — e a primeira pergunta de quem lê seria "então o que eu estou
 * avaliando?".
 *
 * A avaliação é do plano mais completo de propósito: quem experimenta precisa
 * ver o produto inteiro para decidir. Avaliar uma versão recortada é avaliar
 * outro produto, e a decisão sai errada nos dois sentidos.
 */
create or replace function app.plano_de_avaliacao()
returns uuid
language sql
stable
set search_path = public, app, pg_temp
as $$
  select id from public.planos
   where is_active
   order by ordem desc
   limit 1;
$$;

grant execute on function app.plano_de_avaliacao() to service_role;

/* As empresas que já existem e estão em avaliação herdam o mesmo: elas se
   cadastraram antes de haver catálogo, e deixá-las sem plano mostraria "nenhum"
   para quem não fez nada de errado. */
update public.tenants
   set plano_id = app.plano_de_avaliacao()
 where plano_id is null and status in ('trial', 'active');

/*
 * E o GATILHO, para toda empresa nova nascer com plano — não só as que passam
 * pelo cadastro público.
 *
 * `app.criar_empresa_em_avaliacao` é um caminho; `scripts/primeiro-acesso.sh` é
 * outro; uma carga de migração do LTI seria um terceiro. Pôr a regra em cada um
 * garante que o próximo caminho esqueça — é a mesma razão de o dono do registro
 * ser carimbado por gatilho nesta base, e não pela aplicação.
 */
create or replace function app.carimbar_plano_inicial()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if new.plano_id is null then
    new.plano_id := app.plano_de_avaliacao();
  end if;
  return new;
end;
$$;

create trigger trg_tenants_plano_inicial
  before insert on public.tenants
  for each row execute function app.carimbar_plano_inicial();
