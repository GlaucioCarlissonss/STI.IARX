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
ok(previstos.length === 7, `${previstos.length} itens previstos: 6 integrações + fluxo de caixa. 'Links de internet' TEM tela no protótipo, então não é previsto`)

console.log('\n=== 2. Grupo desaparece inteiro quando nada é alcançável ===')
await trocar('u6')  // Operador Financeiro
const gruposFin = await p.$$eval('.nav-group', hs => hs.map(h => h.textContent.trim()))
console.log('  grupos:', gruposFin.join(' | ') || '(nenhum)')
ok(!gruposFin.includes('Atendimento'), 'Operador Financeiro NÃO vê o grupo Atendimento')
ok(!gruposFin.includes('Administração'), 'nem o grupo Administração')
ok(gruposFin.includes('Financeiro'), 'e vê o grupo Financeiro')
const soonFin = await p.$$eval('.nav-soon', ss => ss.length)
ok(soonFin > 0 && !gruposFin.includes('Integrações'),
   'item previsto não fez o grupo Integrações aparecer sozinho')

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
const reprovado = await p.evaluate(() =>
  JSON.parse(localStorage.getItem('sti.helpdesk.v7')).payables.filter(t => t.status === 'rejected').length)
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
const ligado = await p.evaluate(() =>
  JSON.parse(localStorage.getItem('sti.helpdesk.v7')).approvalRequired)
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
const parcelas = await p.evaluate(() => {
  const db = JSON.parse(localStorage.getItem('sti.helpdesk.v7'))
  const g = db.payables.filter(t => t.description === 'Despesa acima de qualquer faixa')
  return g.sort((a,b) => a.installment - b.installment).map(t => t.amount)
})
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
const renomeado = await p.evaluate(() =>
  JSON.parse(localStorage.getItem('sti.helpdesk.v7')).accessProfiles.some(x => x.name === 'Auditor externo'))
ok(renomeado, 'perfil renomeado — antes ficava "Novo perfil" para sempre')

console.log('\n=== 10. Baixa de recebimento com desconto ===')
await irPara('Títulos a receber')
console.log('  título:', await p.$eval('h1', h => h.textContent.trim()))
await p.evaluate(() => document.querySelector('[data-tr-settle]')?.click())
await p.waitForTimeout(200)
await p.fill('#bxm-amount', '7000')
await p.evaluate(() => document.getElementById('modal-save').click())
await p.waitForTimeout(300)
const comDesconto = await p.evaluate(() => {
  const t = JSON.parse(localStorage.getItem('sti.helpdesk.v7')).receivables
    .find(x => x.receivedAmount === 7000)
  return t ? { original:t.amount, recebido:t.receivedAmount } : null
})
console.log('  ', JSON.stringify(comDesconto))
ok(comDesconto && comDesconto.original !== comDesconto.recebido,
   'valor original preservado — a diferença fica visível em vez de desaparecer')

console.log('\n=== Erros de página ===')
console.log(erros.length ? erros.join('\n') : '  nenhum')
await p.screenshot({ path:'/tmp/claude-0/-home-user-STI-IARX/eb021f6b-0a70-55f9-a2c8-13bdbb4bd983/scratchpad/titulos.png' })
await b.close()
