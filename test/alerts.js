// Os alertas dispariam pela estimativa local e so olhavam sessao + semana
// geral. Dava para encostar em 90% do teto semanal de um modelo sem nenhum
// aviso, e para receber "sua sessao passou de 80%" enquanto o painel — que so
// mostra % real — dizia outra coisa.
//
// Aqui: com conta conectada manda o dado real, incluindo um limiar por modelo;
// sem conta a estimativa ainda alerta, mas dizendo que e estimativa.
const { checkAlerts } = require('../alerts')

let falhas = 0
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FALHOU'}  ${msg}`)
  if (!ok) falhas++
}

const CONFIG = { alerts: true, alertThresholds: [80, 95] }
const local = (session, week) => ({ session: { pct: session }, week: { pct: week } })
const real = (session, week, scoped = []) => ({
  session: { pct: session },
  week: { pct: week },
  scoped,
})

// 1. o teto por modelo alerta sozinho, com o resto ainda baixo
{
  const armed = new Set()
  const out = checkAlerts(CONFIG, local(5, 5), real(10, 20, [{ label: 'Fable', pct: 91 }]), armed)
  check(out.length === 1, `um alerta para o teto do modelo (foram ${out.length})`)
  check(
    out[0] === 'O uso semanal de Fable passou de 80% — agora em 91%',
    `texto nomeia o modelo — recebeu: ${out[0]}`,
  )
}

// 2. nao repete no tick seguinte, e o segundo limiar ainda avisa
{
  const armed = new Set()
  const u = real(10, 20, [{ label: 'Fable', pct: 91 }])
  checkAlerts(CONFIG, local(5, 5), u, armed)
  check(checkAlerts(CONFIG, local(5, 5), u, armed).length === 0, 'nao repete o mesmo limiar')
  const out = checkAlerts(CONFIG, local(5, 5), real(10, 20, [{ label: 'Fable', pct: 96 }]), armed)
  check(out.length === 1 && /passou de 95%/.test(out[0]), 'o limiar de cima ainda avisa')
}

// 3. com conta conectada a estimativa local nao alerta nada
{
  const armed = new Set()
  const out = checkAlerts(CONFIG, local(99, 99), real(2, 3), armed)
  check(out.length === 0, `o dado real manda sobre a estimativa (foram ${out.length})`)
}

// 4. sem conta a estimativa ainda avisa, marcada como estimativa
{
  const armed = new Set()
  const out = checkAlerts(CONFIG, local(84, 10), null, armed)
  check(out.length === 1 && / \(estimativa\)$/.test(out[0]), `ressalva no texto: ${out[0]}`)
}

// 5. o modelo que some da lista desarma, senao nunca mais avisaria ao voltar
{
  const armed = new Set()
  checkAlerts(CONFIG, local(5, 5), real(10, 20, [{ label: 'Fable', pct: 91 }]), armed)
  checkAlerts(CONFIG, local(5, 5), real(10, 20, []), armed)
  const out = checkAlerts(CONFIG, local(5, 5), real(10, 20, [{ label: 'Fable', pct: 91 }]), armed)
  check(out.length === 1, 'o teto que volta avisa de novo')
}

// 6. cair abaixo do limiar rearma (reset da janela)
{
  const armed = new Set()
  checkAlerts(CONFIG, local(5, 5), real(85, 20), armed)
  checkAlerts(CONFIG, local(5, 5), real(3, 20), armed)
  const out = checkAlerts(CONFIG, local(5, 5), real(85, 20), armed)
  check(out.length === 1 && /A sessão/.test(out[0]), 'depois do reset a sessao volta a avisar')
}

// 7. alertas desligados nao produzem nada
{
  const armed = new Set()
  const out = checkAlerts({ ...CONFIG, alerts: false }, local(99, 99), real(99, 99), armed)
  check(out.length === 0, 'a chave de alertas desliga tudo')
}

if (falhas) {
  console.error(`\n${falhas} verificacao(oes) falharam.`)
  process.exit(1)
}
console.log('\nOK - alertas seguem o dado real e cobrem o teto por modelo.')
