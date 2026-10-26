#!/usr/bin/env python3
"""
Confere cada `.from('tabela').select('col, col')` do src contra o schema real.

POR QUE ESTE SCRIPT EXISTE
--------------------------
O `tsc` não vê nada aqui: o nome da coluna é uma string, e o `.returns<T>()` é uma
ASSERÇÃO de quem escreveu, não uma verificação. E o erro não aparece em tela
nenhuma — o Supabase devolve `error` e `data` nulo, o `?? []` transforma isso numa
lista vazia, e o resultado é um campo de formulário sem opções. Em silêncio.

Ele achou dois casos reais na primeira execução, os dois `ticket_priorities.name`
(a coluna se chama `label`): um no cadastro de serviço da onda 4 e outro no
cadastro de canal da onda 5. Nos dois, o campo "Prioridade" nunca teve opção
alguma, e nenhum teste pegaria — não há Supabase neste ambiente, e o tipo
asseverado batia com o código.

Exige o banco de validação de pé:
  bash scripts/validate-migrations.sh && python3 scripts/conferir-colunas.py
"""
import os, re, subprocess, sys

RAIZ = '/home/user/STI.IARX'
PSQL = ['psql','-h','127.0.0.1','-p','5433','-U','postgres','-d','sti_iarx_validate','-At','-F','\t','-c']
env = dict(os.environ, PGPASSWORD='postgres')

out = subprocess.run(PSQL + [
  "select table_name, column_name from information_schema.columns where table_schema='public'"
], capture_output=True, text=True, env=env).stdout
colunas = {}
for linha in out.strip().split('\n'):
    if '\t' not in linha: continue
    t, c = linha.split('\t')
    colunas.setdefault(t, set()).add(c)

padrao = re.compile(r"\.from\(\s*'([a-z_0-9]+)'\s*\)\s*(?:\s*//[^\n]*\n)?\s*\.select\(\s*(?:'([^']*)'|`([^`]*)`|\n\s*'([^']*)')", re.S)
problemas = 0
for raiz, _, arquivos in os.walk(os.path.join(RAIZ, 'src')):
    for nome in arquivos:
        if not nome.endswith(('.ts', '.tsx')): continue
        caminho = os.path.join(raiz, nome)
        texto = open(caminho, encoding='utf-8').read()
        for m in padrao.finditer(texto):
            tabela = m.group(1)
            lista = m.group(2) or m.group(3) or m.group(4) or ''
            # Relação aninhada — `ticket:tickets(title, client_id)` — descreve
            # OUTRA tabela. Fora, senão toda junção vira falso positivo.
            #
            # O NOME do embute sai junto com os parênteses. Só os parênteses
            # deixavam `ticket_comments(body)` virar a "coluna" ticket_comments:
            # a forma com apelido escapava pelo `:` e a forma sem apelido não
            # escapava por nada.
            while '(' in lista:
                a = lista.index('(')
                # Fecha CONTANDO profundidade: embute dentro de embute —
                # `conversa:x(contato:y(z))` — faria o primeiro ')' fechar o de
                # dentro, e sobraria um parêntese solto virando "coluna".
                prof, f = 0, -1
                for j in range(a, len(lista)):
                    if lista[j] == '(':
                        prof += 1
                    elif lista[j] == ')':
                        prof -= 1
                        if prof == 0:
                            f = j
                            break
                if f < 0: break
                i = a
                while i > 0 and (lista[i - 1].isalnum() or lista[i - 1] in '_!:'):
                    i -= 1
                lista = lista[:i] + lista[f + 1:]
            if tabela not in colunas:
                continue  # view ou tabela de outro schema
            linha = texto[:m.start()].count('\n') + 1
            for campo in lista.split(','):
                campo = campo.strip()
                if not campo or '(' in campo or ':' in campo or '*' in campo or '!' in campo:
                    continue
                if campo not in colunas[tabela]:
                    print(f"  ERRADO {os.path.relpath(caminho, RAIZ)}:{linha}: {tabela}.{campo} não existe")
                    problemas += 1
print(f"\n{problemas} coluna(s) inexistente(s).")
sys.exit(1 if problemas else 0)
