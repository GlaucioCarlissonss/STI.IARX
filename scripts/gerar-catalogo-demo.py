#!/usr/bin/env python3
"""
Regenera o bloco PERM_CATALOG dentro de demo/sti-tool.html a partir de
src/lib/permissions.ts.

O protótipo é um HTML único sem build e não pode importar o módulo. Manter a
cópia à mão a faria envelhecer calada, então ela é gerada — e
src/lib/permissions.demo.test.ts falha se as duas listas divergirem.

Uso: python3 scripts/gerar-catalogo-demo.py
"""
import io
import os
import re

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS = os.path.join(RAIZ, 'src', 'lib', 'permissions.ts')
HTML = os.path.join(RAIZ, 'demo', 'sti-tool.html')


def entradas():
    s = io.open(TS, encoding='utf-8').read()
    rotulos = dict(
        re.findall(
            r"^\s+([a-z_]+): '([^']+)',",
            s[s.index('MODULE_LABEL'):s.index('export const PERMISSION_CATALOG')],
            re.M,
        )
    )
    corpo = s[s.index('export const PERMISSION_CATALOG'):]
    out = []
    for linha in corpo.split('\n')[1:]:
        t = linha.strip().rstrip(',')
        if t.startswith(']'):
            break
        m = re.fullmatch(r"mod\('([a-z_]+)', '([a-z_]+)'\)", t)
        if m:
            out.append((m.group(1), None, None, rotulos.get(m.group(1), m.group(1)), m.group(2)))
            continue
        m = re.fullmatch(r"scr\('([a-z_]+)', '([a-z_]+)', '([^']*)', '([a-z_]+)'\)", t)
        if m:
            out.append((m.group(1), m.group(2), None, m.group(3), m.group(4)))
            continue
        m = re.fullmatch(r"act\('([a-z_]+)', '([a-z_]+)', '([a-z_]+)', '([^']*)', '([a-z_]+)'\)", t)
        if m:
            out.append((m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)))
    return out


def main():
    itens = entradas()
    assert itens, 'nao consegui ler o catalogo do TypeScript'

    def q(x):
        return 'null' if x is None else "'" + x + "'"

    linhas = []
    for mod, scr, act, label, role in itens:
        key = '.'.join(x for x in (mod, scr, act) if x)
        linhas.append(f"    ['{key}','{mod}',{q(scr)},{q(act)},'{label}','{role}'],")

    html = io.open(HTML, encoding='utf-8').read()
    m = re.search(r"(  const PERM_CATALOG = \[\n)([\s\S]*?)(\n  \];)", html)
    assert m, 'bloco PERM_CATALOG nao encontrado no protótipo'
    novo = html[:m.end(1)] + '\n'.join(linhas) + html[m.start(3):]
    io.open(HTML, 'w', encoding='utf-8').write(novo)
    print(f'catálogo do protótipo regenerado: {len(itens)} entradas')


if __name__ == '__main__':
    main()
