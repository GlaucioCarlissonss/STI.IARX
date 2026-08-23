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

-- -----------------------------------------------------------------------------
-- Schema `storage` mínimo (para validar as policies de anexo da 0019)
-- -----------------------------------------------------------------------------
-- As colunas seguem as do Supabase real, porque a policy é escrita contra elas:
-- fingir um formato diferente aqui provaria uma policy que não é a que roda em
-- produção. Só o subconjunto que as nossas policies tocam.
create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets(id) on delete cascade,
  -- No Supabase `name` é o caminho completo dentro do bucket, com "/" separando
  -- as pastas. É dele que sai o tenant_id.
  name       text not null,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_objects_bucket_name unique (bucket_id, name)
);

-- Só `enable`, sem `force`: é assim no Supabase real, onde a tabela pertence a
-- `supabase_storage_admin` e o serviço de Storage conecta como esse dono. Forçar
-- aqui provaria uma policy sob condição que produção não tem.
alter table storage.objects enable row level security;

-- `storage.foldername('a/b/c.pdf')` => {a,b}. O Supabase descarta o último
-- segmento (o arquivo); replicar esse detalhe importa porque a policy indexa
-- [1] e [2] e um off-by-one deixaria a checagem de tenant olhando o lugar errado.
create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select case
    when array_length(string_to_array(name, '/'), 1) <= 1 then array[]::text[]
    else (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  end;
$$;

create or replace function storage.filename(name text)
returns text
language sql
immutable
as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)];
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to anon, authenticated;
