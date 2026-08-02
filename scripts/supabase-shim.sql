-- =============================================================================
-- Shim de compatibilidade Supabase para validação em PostgreSQL puro
-- =============================================================================
-- NÃO faz parte das migrações. Serve apenas para que `scripts/validate-migrations.sh`
-- consiga aplicar o schema em um Postgres local, recriando os objetos que o
-- Supabase provê de fábrica (schema auth, roles, publicação de realtime).
-- =============================================================================

create schema if not exists auth;
create schema if not exists extensions;

-- Subconjunto de auth.users usado pelas nossas FKs.
create table if not exists auth.users (
  id                uuid primary key default gen_random_uuid(),
  email             text,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

-- Equivalentes às funções nativas do Supabase, sobre os mesmos claims.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

-- Roles que o Supabase cria automaticamente.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- Publicação usada pelo Supabase Realtime.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;
