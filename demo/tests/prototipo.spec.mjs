/*
 * Teste de comportamento do protótipo, em navegador de verdade.
 *
 * Existe porque a comparação estática de catálogo NÃO pega tudo. Este arquivo já
 * achou dois defeitos que nenhum teste unitário pegaria:
 *
 *  1. `ROLE_RANK` invertido no protótipo — o solicitante perdia
 *     `helpdesk.tickets.ver` e abria a ferramenta com três itens de menu, e o
 *     visualizador, que é só leitura, ganhava `helpdesk.tickets.criar`.
 *  2. As REGRAS dos perfis financeiros paradas antes da migração 0020 — o
 *     Operador Financeiro não lançava despesa e o Aprovador não aprovava. O
 *     sintoma era um botão ausente, não um erro.
 *
 * Como rodar (o Chromium já vem no ambiente):
 *   npm i --no-save playwright        # se ainda não houver
 *   node demo/tests/prototipo.spec.mjs
 *
 * O clique é feito por JS onde a gaveta ou o modal tem backdrop que intercepta
 * ponteiro. É legítimo: o protótipo usa delegação de evento no documento.
 */
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const p = await b.newPage({ viewport:{ width:1440, height:1000 } })
const erros = []
p.on('pageerror', e => erros.push('PAGEERROR: ' + e.message))
p.on('console', m => { if (m.type()==='error') erros.push('CONSOLE: ' + m.text()) })
await p.goto('file:///home/user/STI.IARX/demo/sti-tool.html')
await p.waitForSelector('.side button')
const ok = (c,m) => console.log(`${c?'  ok ':'  FALHOU '} ${m}`)
const fechar = async () => {
  await p.evaluate(() => document.querySelector('.modal-head [data-close-modal]')?.click())
  await p.evaluate(() => document.querySelector('#drawer-root [data-close]')?.click())
  await p.waitForTimeout(120)
}
const trocar = async id => { await fechar(); await p.selectOption('#acting-user', id); await p.waitForTimeout(160) }
/* A chave do localStorage sobe de versão a cada mudança de estado do protótipo
   (v7 → v8 nesta rodada). Repeti-la literalmente aqui fazia o teste morrer com
   "reading 'payables' of null" no bump seguinte, o que não diz nada sobre o
   defeito. Descobrir a chave é uma linha e não envelhece. */
const estado = () => p.evaluate(() =>
  JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sti.helpdesk.')))))
const irPara = async texto => {
  await fechar()
  await p.evaluate(t => [...document.querySelectorAll('.side button')]
    .find(b => b.textContent.trim().startsWith(t))?.click(), texto)
  await p.waitForTimeout(200)
}

console.log('\n=== 1. Menu em grupos ===')
await trocar('u1')
const grupos = await p.$$eval('.nav-group', hs => hs.map(h => h.textContent.trim()))
console.log('  grupos:', grupos.join(' | '))
ok(grupos.length >= 6 && grupos.length <= 7, `${grupos.length} grupos — dentro do teto de 7`)
ok(grupos.includes('Financeiro') && grupos.includes('Integrações'), 'Financeiro e Integrações presentes')
const previstos = await p.$$eval('.nav-soon', ss => ss.map(s => s.textContent.replace('em breve','').trim()))
console.log('  em breve:', previstos.join(' | '))
ok(previstos.length === 6, `${previstos.length} itens previstos: só as 6 integrações. Fluxo de caixa e Links de internet TÊM tela e permissão própria desde as migrações 0021/0022`)

console.log('\n=== 2. Grupo desaparece inteiro quando nada é alcançável ===')
await trocar('u6')  // Operador Financeiro
const gruposFin = await p.$$eval('.nav-group', hs => hs.map(h => h.textContent.trim()))
console.log('  grupos:', gruposFin.join(' | ') || '(nenhum)')
ok(!gruposFin.includes('Atendimento'), 'Operador Financeiro NÃO vê o grupo Atendimento')
ok(!gruposFin.includes('Administração'), 'nem o grupo Administração')
ok(gruposFin.includes('Financeiro'), 'e vê o grupo Financeiro')
const soonFin = await p.$$eval('.nav-soon', ss => ss.length)
/* Os 6 previstos que restam são TODOS de Integrações, e o único item real desse
   grupo (o hub de tickets) está fora do alcance deste perfil. Então o grupo
   desaparece inteiro apesar de ter 6 itens previstos — que é exatamente a regra.
   Antes da 0021 este perfil ainda via um previsto (o Fluxo de caixa, no grupo
   Financeiro); agora ele vê zero, e é isso que a asserção passa a afirmar. */
ok(soonFin === 0 && !gruposFin.includes('Integrações'),
   'os 6 previstos são todos de Integrações, e o grupo não aparece para quem não alcança o item real dele')

console.log('\n=== 3. Títulos a pagar — separação de função ===')
await irPara('Títulos a pagar')
console.log('  título:', await p.$eval('h1', h => h.textContent.trim()))
const botoesOp = await p.$$eval('.page-head button', bs => bs.map(x => x.textContent.trim()))
console.log('  botões do cabeçalho:', botoesOp.join(' | ') || '(nenhum)')
ok(botoesOp.includes('Lançar despesa'), 'Operador Financeiro LANÇA despesa')
const acoesOp = await p.$$eval('tbody .row-actions button', bs => bs.map(x => x.textContent.trim()))
ok(!acoesOp.includes('Aprovar'), 'Operador Financeiro NÃO tem botão Aprovar')
ok(!acoesOp.includes('Pagar'), 'Operador Financeiro NÃO tem botão Pagar')
const temConfig = await p.$('#tp-toggle-approval')
ok(temConfig === null, 'Operador Financeiro NÃO vê a configuração de alçada')

await trocar('u7')  // Aprovador Financeiro
await irPara('Títulos a pagar')
const acoesAp = await p.$$eval('tbody .row-actions button', bs => bs.map(x => x.textContent.trim()))
console.log('  ações do aprovador:', [...new Set(acoesAp)].join(' | '))
ok(acoesAp.includes('Aprovar'), 'Aprovador Financeiro TEM botão Aprovar')
ok(!acoesAp.includes('Pagar'), 'Aprovador Financeiro NÃO paga')
const botoesAp = await p.$$eval('.page-head button', bs => bs.map(x => x.textContent.trim()))
ok(!botoesAp.includes('Lançar despesa'), 'Aprovador Financeiro NÃO lança despesa')

console.log('\n=== 4. Reprovar exige motivo ===')
await p.evaluate(() => document.querySelector('[data-tp-decide]')?.click())
await p.waitForTimeout(200)
await p.evaluate(() => document.getElementById('apm-reject')?.click())
await p.waitForTimeout(200)
const msgRej = await p.$eval('#apm-msg', e => e.textContent.trim()).catch(() => '')
console.log('  mensagem:', msgRej.slice(0, 90))
ok(/motivo/i.test(msgRej), 'reprovação sem motivo é recusada')
await p.fill('#apm-note', 'Falta a proposta comercial anexada.')
await p.evaluate(() => document.getElementById('apm-reject')?.click())
await p.waitForTimeout(250)
const reprovado = (await estado()).payables.filter(t => t.status === 'rejected').length
ok(reprovado >= 2, 'reprovação com motivo é gravada')

console.log('\n=== 5. Alçada: ligar sem faixa é recusado ===')
await trocar('u1')
await irPara('Títulos a pagar')
await p.evaluate(() => document.getElementById('tp-toggle-approval')?.click())
await p.waitForTimeout(250)
let toasts = await p.$$eval('.toast,[class*=toast]', ts => ts.map(t => t.textContent.trim()))
console.log('  toast:', toasts.join(' / ') || '(nenhum)')
ok(toasts.some(t => /faixa de alçada antes/i.test(t)), 'ligar aprovação sem faixa é recusado')

console.log('\n=== 6. Cadastrar faixa e ligar ===')
await p.evaluate(() => document.getElementById('tp-new-rule')?.click())
await p.waitForTimeout(200)
await p.fill('#arm-name', 'Coordenação')
await p.fill('#arm-max', '5000')
await p.evaluate(() => document.getElementById('modal-save').click())
await p.waitForTimeout(250)
await p.evaluate(() => document.getElementById('tp-toggle-approval')?.click())
await p.waitForTimeout(250)
const ligado = (await estado()).approvalRequired
ok(ligado === true, 'com faixa cadastrada, a aprovação liga')

console.log('\n=== 7. Lançar despesa acima da faixa é recusado com explicação ===')
await p.evaluate(() => document.getElementById('tp-new')?.click())
await p.waitForTimeout(200)
await p.fill('#tpm-desc', 'Despesa acima de qualquer faixa')
await p.fill('#tpm-amount', '90000')
await p.evaluate(() => document.getElementById('modal-save').click())
await p.waitForTimeout(250)
const msgFaixa = await p.$eval('#tpm-msg', e => e.textContent.trim()).catch(() => '')
console.log('  mensagem:', msgFaixa.slice(0, 110))
ok(/nenhuma faixa/i.test(msgFaixa), 'valor fora de toda faixa é recusado dizendo o que configurar')

console.log('\n=== 8. Parcelamento: sobra do centavo na PRIMEIRA parcela ===')
await p.fill('#tpm-amount', '100')
await p.fill('#tpm-parcelas', '3')
await p.evaluate(() => document.getElementById('modal-save').click())
await p.waitForTimeout(300)
const parcelas = (await estado()).payables
  .filter(t => t.description === 'Despesa acima de qualquer faixa')
  .sort((a,b) => a.installment - b.installment)
  .map(t => t.amount)
console.log('  parcelas de R$ 100 em 3x:', parcelas.join(' + '), '=', parcelas.reduce((a,b)=>a+b,0))
ok(parcelas.length === 3, '3 parcelas geradas')
ok(Math.abs(parcelas.reduce((a,b)=>a+b,0) - 100) < 0.001, 'a soma fecha exatamente em 100')
ok(parcelas[0] >= parcelas[1], 'a sobra ficou na PRIMEIRA parcela')

console.log('\n=== 9. Editar perfil de acesso (o que faltava) ===')
await irPara('Perfis de acesso')
await p.evaluate(() => document.getElementById('profile-new')?.click())
await p.waitForTimeout(250)
const temNome = await p.$('#pm-name')
ok(temNome !== null, 'o modal do perfil agora tem campo de NOME')
ok(await p.$('#pm-baseRole') !== null, 'e de papel implicado (teto)')
await p.fill('#pm-name', 'Auditor externo')
await p.fill('#pm-desc', 'Somente leitura para auditoria.')
await p.evaluate(() => document.getElementById('modal-save').click())
await p.waitForTimeout(300)
const renomeado = (await estado()).accessProfiles.some(x => x.name === 'Auditor externo')
ok(renomeado, 'perfil renomeado — antes ficava "Novo perfil" para sempre')

console.log('\n=== 10. Baixa de recebimento com desconto ===')
await irPara('Títulos a receber')
console.log('  título:', await p.$eval('h1', h => h.textContent.trim()))
await p.evaluate(() => document.querySelector('[data-tr-settle]')?.click())
await p.waitForTimeout(200)
await p.fill('#bxm-amount', '7000')
await p.evaluate(() => document.getElementById('modal-save').click())
await p.waitForTimeout(300)
const baixado = (await estado()).receivables.find(x => x.receivedAmount === 7000)
const comDesconto = baixado
  ? { original:baixado.amount, recebido:baixado.receivedAmount }
  : null
console.log('  ', JSON.stringify(comDesconto))
ok(comDesconto && comDesconto.original !== comDesconto.recebido,
   'valor original preservado — a diferença fica visível em vez de desaparecer')

console.log('\n=== 11. Fluxo de caixa: a projeção responde ao percentual ===')
await trocar('u1')
await irPara('Fluxo de caixa')
console.log('  título:', await p.$eval('h1', h => h.textContent.trim()))
const linhasFluxo = await p.$$eval('.table-wrap tbody tr', rs => rs.length)
ok(linhasFluxo === 12, `${linhasFluxo} baldes — um por mês do horizonte padrão`)

const lerReceber = () => p.$$eval('.tile', ts => {
  const t = ts.find(x => x.querySelector('.tile-label')?.textContent.includes('A receber'))
  return t ? t.querySelector('.tile-value').textContent.trim() : null
})
const receberIntegral = await lerReceber()
await p.selectOption('#fc-meses', '24')
await p.waitForTimeout(160)
const linhas24 = await p.$$eval('.table-wrap tbody tr', rs => rs.length)
ok(linhas24 === 24, `horizonte de 24 meses devolve ${linhas24} baldes`)

await p.fill('#fc-inad', '100')
await p.$eval('#fc-inad', el => el.dispatchEvent(new Event('change', { bubbles:true })))
await p.waitForTimeout(160)
const receberZerado = await lerReceber()
console.log('  a receber:', receberIntegral, '→', receberZerado)
ok(receberIntegral !== receberZerado && /0,00/.test(receberZerado),
   '100% de inadimplência zera as entradas, e só as entradas')
const pagarCom100 = await p.$$eval('.tile', ts => {
  const t = ts.find(x => x.querySelector('.tile-label')?.textContent.includes('A pagar'))
  return t ? t.querySelector('.tile-value').textContent.trim() : null
})
ok(pagarCom100 && !/^R\$ 0,00$/.test(pagarCom100),
   'inadimplência NÃO mexe no que se tem a pagar — senão "pessimista" reduziria a dívida')

console.log('\n=== 12. Links de internet: permissão própria, finalmente ===')
await p.fill('#fc-inad', '0')
await p.$eval('#fc-inad', el => el.dispatchEvent(new Event('change', { bubbles:true })))
await irPara('Links de internet')
const semAviso = await p.$$eval('.alert', as =>
  as.every(a => !a.textContent.includes('ainda não tem permissão própria')))
ok(semAviso, 'o aviso de "tela sem permissão própria" saiu — a chave existe agora')
const botaoNovoLink = await p.$$eval('#link-new', bs => bs.length)
ok(botaoNovoLink === 1, 'o Admin vê o botão de novo link')

// Operador Financeiro NÃO alcança conectividade: o item some do menu.
await trocar('u6')
const itens = await p.$$eval('.side button', bs => bs.map(b => b.textContent.trim()))
ok(!itens.some(t => t.startsWith('Links de internet')),
   'Operador Financeiro não vê Links de internet — módulo conectividade não é dele')
ok(itens.some(t => t.startsWith('Fluxo de caixa')),
   'e vê Fluxo de caixa, que é do módulo financeiro')

// Operador de TI consulta o link e NÃO cadastra.
await trocar('u3')
await irPara('Links de internet')
const novoLinkOperador = await p.$$eval('#link-new', bs => bs.length)
console.log('  título:', await p.$eval('h1', h => h.textContent.trim()))
ok(novoLinkOperador === 0, 'Operador de TI consulta links e NÃO vê o botão de cadastrar')

console.log('\n=== 13. Áreas da filial: cadastro que só existia em SQL ===')
await trocar('u1')
await irPara('Inventário')
const abreAreas = await p.$$eval('#areas-open', bs => bs.length)
ok(abreAreas === 1, 'o Admin vê o botão de gerenciar áreas')
await p.evaluate(() => document.getElementById('areas-open')?.click())
await p.waitForTimeout(250)
const antesAreas = (await estado()).areas.length
await p.fill('#am-name', 'Fisioterapia')
await p.evaluate(() => document.getElementById('am-add')?.click())
await p.waitForTimeout(250)
const depoisAreas = (await estado()).areas.length
ok(depoisAreas === antesAreas + 1, `área criada (${antesAreas} → ${depoisAreas})`)

// Nome duplicado é recusado sem diferenciar maiúsculas — é a unicidade que dá
// sentido ao agrupamento por área.
await p.fill('#am-name', 'fisioterapia')
await p.evaluate(() => document.getElementById('am-add')?.click())
await p.waitForTimeout(250)
const msgArea = await p.$eval('#am-msg', el => el.textContent.trim())
console.log('  mensagem:', msgArea.slice(0, 80))
ok(/já existe/i.test(msgArea), 'nome repetido é recusado sem diferenciar maiúsculas')
ok((await estado()).areas.length === depoisAreas, 'e nada foi gravado')

console.log('\n=== 14. Custódia: quem não é gestor não transfere patrimônio ===')
await fechar()
// Operador de TI: papel atendente, consulta o parque e não mexe em patrimônio.
await trocar('u3')
await irPara('Inventário')
const areasOperador = await p.$$eval('#areas-open', bs => bs.length)
ok(areasOperador === 0, 'Operador de TI não vê o botão de gerenciar áreas')
// O formulário de custódia fica na aba Dados da gaveta, que já abre selecionada.
await p.evaluate(() => document.querySelector('tbody tr[data-asset]')?.click())
await p.waitForTimeout(300)
ok(await p.$$eval('#drawer-root aside', d => d.length === 1), 'a gaveta do ativo abre')
const salvarOperador = await p.$$eval('#as-save', bs => bs.length)
ok(salvarOperador === 0, 'e não vê o botão de salvar custódia')

await fechar()
await trocar('u4')  // Gestor de TI
await irPara('Inventário')
await p.evaluate(() => document.querySelector('tbody tr[data-asset]')?.click())
await p.waitForTimeout(300)
const salvarGestor = await p.$$eval('#as-save', bs => bs.length)
ok(salvarGestor === 1, 'Gestor de TI vê o botão — custódia é ato patrimonial, e é dele')

// E a timeline continua visível para os dois: consultar o histórico não é
// transferir patrimônio, e esconder o registro de quem só consulta tiraria
// justamente a auditoria que o módulo existe para dar.
await p.evaluate(() => document.querySelector('[data-assettab="cust"]')?.click())
await p.waitForTimeout(250)
const temTimeline = await p.$$eval('#drawer-root .timeline', t => t.length)
ok(temTimeline === 1, 'a timeline de custódia aparece na aba Custódia')

console.log('\n=== Erros de página ===')
console.log(erros.length ? erros.join('\n') : '  nenhum')
await p.screenshot({ path:'/tmp/claude-0/-home-user-STI-IARX/eb021f6b-0a70-55f9-a2c8-13bdbb4bd983/scratchpad/titulos.png' })
await b.close()
