-- =============================================================================
-- 0047 — As esferas de negócio do tenant
-- =============================================================================
-- O sistema passa a atender DOIS negócios diferentes dentro da mesma base:
--
--   `management` — a TI que responde pelo parque de um cliente. O dinheiro SAI:
--                  nota de terceiro → título a pagar → orçamento de TI.
--   `rental`     — o fornecedor que aluga equipamento próprio e presta serviço.
--                  O dinheiro ENTRA: contrato + medição → fatura → título a
--                  receber.
--
-- Por que isto não é permissão
-- ----------------------------
-- Permissão responde "esta pessoa pode abrir esta tela?". A esfera responde
-- "esta tela existe neste negócio?". São perguntas diferentes, e confundi-las é
-- como a navegação vira depósito: um gestor de TI com todas as permissões do
-- mundo não deveria ver "Tabelas de franquia", e um locador não deveria ver
-- "Agentes nas máquinas". Por isso a esfera é atributo da EMPRESA, não do
-- usuário nem do perfil de acesso.
--
-- Por que um array, e não duas colunas booleanas
-- ----------------------------------------------
-- Porque a pergunta que o código faz é de pertinência — `'rental' = any(spheres)`
-- —, e porque uma terceira esfera no futuro é uma linha no CHECK em vez de uma
-- coluna nova em uma tabela que toda sessão lê. Duplicata no array é inofensiva
-- (a leitura é por pertinência), então não há CHECK de unicidade: um CHECK não
-- aceita subconsulta, e uma trigger só para isso seria cerimônia sem defeito
-- correspondente.
--
-- O padrão é `management`
-- -----------------------
-- Todo tenant existente hoje é uma operação de gestão de TI — esta base nasceu
-- helpdesk. Qualquer outro padrão ligaria, na migração, um módulo que ninguém
-- pediu em todas as instalações.
-- =============================================================================

alter table public.tenants
  add column spheres text[] not null default array['management']::text[];

comment on column public.tenants.spheres is
  'Esferas de negócio da empresa: management (gestão de TI) e/ou rental (locação e serviços). Governa quais telas EXISTEM, não quem pode abri-las.';

-- Valor fora da lista é erro de escrita, não dado: sem este CHECK, um 'rentaI'
-- com i maiúsculo viraria uma esfera que nunca liga nada, em silêncio.
alter table public.tenants
  add constraint tenants_spheres_known
  check (spheres <@ array['management', 'rental']::text[]);

-- Empresa sem esfera nenhuma não teria tela nenhuma — nem a de preferências, que
-- é onde se desfaz o engano. O banco recusa antes que alguém se tranque do lado
-- de fora.
alter table public.tenants
  add constraint tenants_spheres_not_empty
  check (array_length(spheres, 1) >= 1);
