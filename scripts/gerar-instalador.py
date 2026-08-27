#!/usr/bin/env python3
"""
Junta as migrações e o seed num arquivo único para colar no SQL Editor do Supabase.

Existe porque instalar 20 arquivos à mão é convite a errar a ordem, e a ordem
importa: a 0005 usa tabelas que a 0002 criou. Gerar em vez de manter à mão evita
o problema clássico do arquivo-cópia que envelhece calado.

Uso:  python3 scripts/gerar-instalador.py
Saída: entrega/instalar-banco-completo.sql
"""
import io
import os
import glob
import re

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESTINO = os.path.join(RAIZ, 'entrega', 'instalar-banco-completo.sql')


def sem_transacao_propria(txt: str) -> str:
    """
    Remove `begin;`/`commit;` de cada arquivo.

    O instalador inteiro roda numa transação só, então transação aninhada aqui
    faria a 0019 confirmar no meio e o seed abrir outra — e um erro depois disso
    deixaria metade aplicada, que é justamente o que se quer evitar.
    """
    return '\n'.join(
        l for l in txt.split('\n') if l.strip().lower() not in ('begin;', 'commit;')
    )


def conta_objetos(migracoes):
    """Conta o que o instalador cria, lendo o próprio SQL — número na mão erra."""
    todo = '\n'.join(io.open(f, encoding='utf-8').read() for f in migracoes)
    return {
        'tabelas': len(re.findall(r'(?im)^create table (?:if not exists )?public\.', todo)),
        'views': len(set(re.findall(r'(?im)^create (?:or replace )?view public\.(\w+)', todo))),
    }


def main() -> None:
    migracoes = sorted(glob.glob(os.path.join(RAIZ, 'supabase', 'migrations', '*.sql')))
    seed = os.path.join(RAIZ, 'supabase', 'seed.sql')
    total = len(migracoes) + 1
    assert migracoes, 'nenhuma migração encontrada'

    partes = [f"""-- =============================================================================
-- STI.IARX — instalação completa do banco, em um arquivo
-- =============================================================================
-- COMO USAR
--   1. No Supabase, menu lateral -> SQL Editor -> New query
--   2. Cole este arquivo INTEIRO
--   3. Clique em Run
--
-- ARQUIVO GERADO por scripts/gerar-instalador.py. Não edite aqui: edite
-- supabase/migrations/*.sql e gere de novo, senão o banco passa a divergir do
-- repositório e ninguém sabe qual dos dois é a verdade.
--
-- TUDO OU NADA: roda numa única transação. Se qualquer linha falhar, NADA é
-- aplicado e o banco fica como estava. É de propósito — schema aplicado pela
-- metade é pior que schema nenhum, porque a segunda tentativa esbarra no que a
-- primeira deixou pronto.
--
-- O QUE ASSUME QUE JÁ EXISTE (o Supabase provê de fábrica)
--   auth.users, auth.jwt(), storage.buckets, storage.objects,
--   storage.foldername() e os papéis anon / authenticated / service_role.
--   `scripts/supabase-shim.sql` NÃO entra aqui: ele existe só para rodar as
--   migrações num PostgreSQL puro, sem Supabase.
--
-- SE DER ERRO
--   Copie a mensagem INTEIRA. Ela diz qual linha reclamou, e é com ela que se
--   conserta — adivinhar não funciona.
-- =============================================================================

begin;
"""]

    for i, f in enumerate(migracoes, 1):
        partes.append(f"""
-- =============================================================================
-- ARQUIVO {i} de {total}: {os.path.basename(f)}
-- =============================================================================
""")
        partes.append(sem_transacao_propria(io.open(f, encoding='utf-8').read()))

    partes.append(f"""
-- =============================================================================
-- ARQUIVO {total} de {total}: seed.sql — dados de exemplo
-- =============================================================================
-- Só faz sentido em banco novo ou de teste: cria 7 usuários em auth.users. Num
-- banco com dado real, apague daqui para baixo antes de rodar.
""")
    partes.append(sem_transacao_propria(io.open(seed, encoding='utf-8').read()))

    partes.append("""
commit;

-- =============================================================================
-- Conferência — rode DEPOIS, numa consulta separada
-- =============================================================================
--   select
--     (select count(*) from pg_tables   where schemaname = 'public') as tabelas,
--     (select count(*) from pg_views    where schemaname = 'public') as views,
--     (select count(*) from pg_policies where schemaname = 'public') as policies,
--     (select count(*) from pg_policies where schemaname = 'storage') as pol_storage,
--     (select count(*) from public.access_profiles)   as perfis,
--     (select count(*) from public.permission_catalog) as permissoes,
--     (select count(*) from public.profiles)          as usuarios;
--
-- Esperado:  52 | 17 | 138 | 3 | 9 | 114 | 7
--
-- São 9 perfis porque o seed cria UM tenant, e cada tenant nasce com os 9
-- perfis do sistema por trigger. Dois tenants dariam 18.
-- =============================================================================
""")

    os.makedirs(os.path.dirname(DESTINO), exist_ok=True)
    io.open(DESTINO, 'w', encoding='utf-8').write('\n'.join(partes))

    n = conta_objetos(migracoes)
    linhas = sum(1 for _ in io.open(DESTINO, encoding='utf-8'))
    print(f'gerado: {os.path.relpath(DESTINO, RAIZ)}')
    print(f'  {total} arquivos, {linhas} linhas')
    print(f'  {n["tabelas"]} create table, {n["views"]} views')


if __name__ == '__main__':
    main()
