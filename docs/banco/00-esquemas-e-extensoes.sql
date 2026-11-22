-- =============================================================================
-- 00 — ESQUEMAS, EXTENSÕES E AS FUNÇÕES QUE AS TABELAS EXIGEM
--
-- GERADO — não edite este arquivo.
--
-- Ele é lido do catálogo do PostgreSQL por
-- `scripts/gerar-artefatos-do-banco.py`, a partir de um banco feito só das
-- migrações. A fonte da verdade continua sendo `supabase/migrations/`; isto
-- aqui é o retrato consolidado do que elas produzem, para quem precisa LER o
-- schema inteiro de uma vez em vez de atravessar 64 arquivos.
--
-- Para mudar o schema: migração nova. Para atualizar este arquivo: rode o
-- gerador. `npm test` fica vermelho quando os dois divergem.
-- =============================================================================

-- `app` guarda a regra e a esconde de `public`. É o mais perto que o
-- PostgreSQL chega de um package do Oracle — que ele não tem.
--
-- `pgcrypto` gera uuid e hash; `unaccent` é o que faz a busca achar
-- "manutencao" quando a pessoa digita "manutenção".

create schema if not exists app;
create extension if not exists pgcrypto;
create extension if not exists unaccent;


-- --------------------------------------------------------------------------
-- Busca textual: public.portugues_sem_acento
-- --------------------------------------------------------------------------
create text search configuration public.portugues_sem_acento (copy = pg_catalog.portuguese);
alter text search configuration public.portugues_sem_acento
  alter mapping for asciihword with portuguese_stem;
alter text search configuration public.portugues_sem_acento
  alter mapping for asciiword with portuguese_stem;
alter text search configuration public.portugues_sem_acento
  alter mapping for email with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for file with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for float with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for host with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for hword with unaccent, portuguese_stem;
alter text search configuration public.portugues_sem_acento
  alter mapping for hword_asciipart with portuguese_stem;
alter text search configuration public.portugues_sem_acento
  alter mapping for hword_numpart with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for hword_part with unaccent, portuguese_stem;
alter text search configuration public.portugues_sem_acento
  alter mapping for int with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for numhword with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for numword with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for sfloat with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for uint with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for url with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for url_path with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for version with simple;
alter text search configuration public.portugues_sem_acento
  alter mapping for word with unaccent, portuguese_stem;

-- --------------------------------------------------------------------------
-- As funções que restrições `check` chamam (1)
-- --------------------------------------------------------------------------

-- app.eh_competencia
CREATE OR REPLACE FUNCTION app.eh_competencia(p_dia date)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select p_dia is null or extract(day from p_dia) = 1;
$function$
;
