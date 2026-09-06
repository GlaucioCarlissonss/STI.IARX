# Como ligar a plataforma no Supabase do cliente

> **Este documento existe porque a tarefa está aberta.** O passo a passo tinha sido escrito
> só na conversa, e conversa se perde. Enquanto as três partes abaixo não forem feitas por
> uma pessoa com acesso ao painel, a aplicação continua rodando contra um banco de teste e
> nenhuma validação em navegador contra o Supabase real é possível.

O ambiente é um **Supabase auto-hospedado**, rodando em contêiner Docker sob o Coolify,
atrás da VPN, publicado em `supabase.iartech.cloud`.

---

## Antes de tudo: por que o endereço que o Studio mostra não serve

O Studio exibe, na tela de conexão:

```
postgresql://postgres:[YOUR-PASSWORD]@127.0.0.1:5432/postgres
```

`127.0.0.1` quer dizer **"eu mesmo"**. Esse endereço é verdadeiro **de dentro** do contêiner
do Supabase e falso em qualquer outro lugar. Se você colar isso aqui, a aplicação vai
procurar um banco dentro dela mesma e não achar nada.

O endereço que serve é o **público**, o mesmo que você digita no navegador para abrir o
Studio: `https://supabase.iartech.cloud`. É esse que entra na configuração.

---

## Parte 1 — Liberar o endereço na política de rede *(depende de você)*

Hoje, quando tento alcançar `supabase.iartech.cloud` daqui, a resposta é
`403 connect_rejected`: o ambiente onde eu rodo tem uma lista de endereços permitidos, e o
seu Supabase não está nela.

**O que fazer:** nas configurações do ambiente (a mesma tela onde se escolhe a política de
rede), incluir `supabase.iartech.cloud` entre os destinos permitidos.

Sem isso eu consigo escrever e testar o código, mas não consigo abrir a aplicação ligada ao
seu banco para conferir com você.

---

## Parte 2 — Colocar as três chaves na configuração do ambiente *(depende de você)*

No Studio: **Settings → API**. Lá aparecem três coisas. Elas vão na **configuração do
ambiente** — o lugar onde se cadastram variáveis — e **não na conversa**.

| Nome da variável | O que colar | Pode ser pública? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://supabase.iartech.cloud` | sim |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | a chave marcada **anon / public** | sim, é feita para isso |
| `SUPABASE_SERVICE_ROLE_KEY` | a chave marcada **service_role / secret** | **NUNCA** |

### As duas regras que não podem ser quebradas

**1. `SUPABASE_SERVICE_ROLE_KEY` nunca recebe o prefixo `NEXT_PUBLIC_`.**
Esse prefixo não é enfeite de nome: ele manda o valor junto com a página para o navegador de
quem abrir o site. E a `service_role` **ignora todas as regras de segurança do banco** — ela
lê e escreve os dados de todos os clientes. Publicar essa chave é entregar o banco inteiro
para qualquer visitante. A `anon`, ao contrário, é feita para ser pública: sozinha ela não
enxerga nada, porque quem decide o que ela vê são as políticas de RLS.

Nesta plataforma a `service_role` é usada em **exatamente dois lugares**, e está escrito
assim no ADR-011: a rota `/tv/[token]` (o painel de parede, que não tem usuário logado) e o
provisionamento de um usuário novo. Mais nada — nem o upload de anexo, que passa pela sessão
da própria pessoa.

**2. `tenant_id` vai em `app_metadata`, nunca em `user_metadata`.**
Quando um usuário for criado, o identificador do cliente dele tem de ir no bloco
`app_metadata`. O bloco `user_metadata` é **escrito pelo próprio usuário** (qualquer pessoa
logada pode chamar `updateUser()`), então guardar o `tenant_id` ali deixaria qualquer um
mudar de cliente e ver os dados de outra empresa.

---

## Parte 3 — Instalar o banco *(pode ser feita agora, não depende da Parte 1)*

O arquivo `entrega/instalar-banco-completo.sql` deste repositório é o banco inteiro num
arquivo só: tabelas, views, funções, políticas de segurança, catálogo de permissões e perfis.
Ele foi montado para o **SQL Editor** do Studio.

1. Abrir `https://supabase.iartech.cloud` e entrar.
2. Menu lateral: **SQL Editor** → **New query**.
3. Abrir `entrega/instalar-banco-completo.sql`, **copiar tudo** e colar.
4. **Run**.

**É tudo ou nada.** O arquivo abre uma transação no começo e fecha no fim: se qualquer linha
der erro, nada é gravado e o banco fica exatamente como estava. Isso foi testado forçando um
erro no meio do arquivo — sobraram zero tabelas. Então não existe o risco de ficar
"metade instalado".

Se der erro, o texto do erro é o que precisa ser reportado — ele diz a linha.

---

## Depois que as três partes estiverem prontas

Aí é a minha vez. Com o endereço liberado e as chaves no lugar, eu faço a validação ponta a
ponta em navegador:

- entrar com um usuário de cada perfil e conferir que o menu muda;
- abrir um ticket, lançar um título, aprovar e pagar;
- **subir um anexo de verdade** — esta é a única coisa que nenhuma asserção local prova. As
  políticas do bucket `anexos` (migração 0019) são verificadas contra PostgreSQL local, mas o
  Storage do Supabase é um serviço separado, e serviço separado só se prova usando.

---

## Situação atual

| Parte | Situação |
|---|---|
| 1 — liberar `supabase.iartech.cloud` na política de rede | **pendente com você** |
| 2 — três chaves na configuração do ambiente | **pendente com você** |
| 3 — rodar `entrega/instalar-banco-completo.sql` no SQL Editor | **pendente com você** — e já pode ser feita |
| 4 — validação em navegador, com upload real | **pendente comigo**, depende de 1 e 2 |

Enquanto isso, o desenvolvimento segue contra PostgreSQL 16 local com as mesmas migrações,
o mesmo seed e as mesmas asserções de RLS que rodam na CI.
