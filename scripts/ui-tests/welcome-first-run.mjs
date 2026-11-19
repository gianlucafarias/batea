// Primera vez: arranque, primera pantalla (solo la pregunta), presentación mientras importa, saltar, repetir,
// interruptor de búsqueda automática y usuario que ya tiene temas.
//   A = http://127.0.0.1:8766  instalación nueva (base vacía)
//   B = http://127.0.0.1:8768  usuario que ya tiene temas (presentación sin ver)
//   C = http://127.0.0.1:8770  otra instalación nueva (para «Entrar sin importar nada»)
//   Uso: node welcome-first-run.mjs /ruta/a/una/carpeta/con/musica
import puppeteer from 'puppeteer-core'

const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const A = 'http://127.0.0.1:8766/'
const B = 'http://127.0.0.1:8768/'
const C = 'http://127.0.0.1:8770/'
const MUSIC = process.argv[2]
const j = async (u) => (await fetch(u)).json()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(cond ? '  ok    ' : '  FALLA ', name, extra) }

const browser = await puppeteer.launch({ executablePath: CH, headless: 'new', args: ['--no-first-run', '--disable-gpu'], defaultViewport: { width: 1480, height: 920 } })
const watch = () => {
  window.__seen = { sidebar: false, welcome: false, splash: false, stage: false }
  new MutationObserver(() => {
    if (document.querySelector('.sidebar')) window.__seen.sidebar = true
    if (document.querySelector('.welcome')) window.__seen.welcome = true
    if (document.querySelector('.splash')) window.__seen.splash = true
    if (document.querySelector('.wl-stage')) window.__seen.stage = true
  }).observe(document, { childList: true, subtree: true })
}
const open = async (url, folder) => {
  const p = await browser.newPage()
  await p.evaluateOnNewDocument(watch)
  if (folder) await p.evaluateOnNewDocument((f) => { window.pywebview = { api: { pick_folder: async () => f } } }, folder)
  await p.goto(url, { waitUntil: 'domcontentloaded' })
  return p
}
const eyebrow = (p) => p.$eval('.wl-eyebrow', (e) => e.textContent)
const clickText = async (p, sel, text) => {
  for (const h of await p.$$(sel)) {
    if ((await h.evaluate((e) => e.textContent)).includes(text)) { await h.click(); return true }
  }
  return false
}

console.log('A) primera vez (biblioteca vacía, presentación sin ver)')
let p = await open(A, MUSIC)
await p.waitForSelector('.welcome', { timeout: 15000 })
let seen = await p.evaluate(() => window.__seen)
ok('se muestra la bienvenida', seen.welcome)
ok('nunca aparece la app vacía (sidebar) antes', !seen.sidebar)
ok('hubo pantalla de arranque antes', seen.splash)
ok('PRIMERA pantalla: solo la pregunta, sin diapositivas', !!(await p.$('.setup')) && !(await p.$('.wl-stage')) && !(await p.$('.wl-dots')))
await sleep(4000)
ok('no arrancó ninguna importación ni búsqueda sola', (await j(A + 'api/jobs')).length === 0)
ok('la búsqueda automática sigue apagada', (await j(A + 'api/status')).autodiscover === false)
ok('con «Más tarde» el botón dice «Entrar sin importar nada»', (await p.$eval('.su-foot .wl-cta', (e) => e.textContent)).includes('Entrar sin importar'))
await clickText(p, '.wl-opt', 'Solo una carpeta'); await sleep(300)
ok('elegir «Solo una carpeta» pide la carpeta y la muestra', (await p.$eval('.su-body', (e) => e.textContent)).includes('Music'))
ok('recién ahora dice «Empezar»', (await p.$eval('.su-foot .wl-cta', (e) => e.textContent)) === 'Empezar')
await p.click('.su-foot .wl-cta')
await p.waitForSelector('.wl-stage', { timeout: 15000 })
ok('al confirmar aparecen las diapositivas con el progreso', !!(await p.$('.wl-slide')) && !!(await p.$('.wl-load')))
await p.mouse.move(740, 400)
const first = await eyebrow(p)
await sleep(9500)
const moved = await eyebrow(p)
ok('avanza solo con el mouse encima de la diapositiva', moved !== first, `${first} → ${moved}`)
const dots = await p.$$('.wl-dot'); await dots[4].click(); await sleep(500)
ok('click en el 5º punto → diapositiva 5', (await eyebrow(p)).startsWith('05 /'))
await p.keyboard.press('ArrowLeft'); await sleep(400)
ok('flecha izquierda → diapositiva 4', (await eyebrow(p)).startsWith('04 /'))
await p.click('.wl-play'); await sleep(300)
const frozen = await eyebrow(p); await sleep(9500)
ok('el botón de pausa frena el avance', (await eyebrow(p)) === frozen, frozen)
await p.click('.wl-play')
await p.waitForFunction(() => [...document.querySelectorAll('.wl-cta')].some((b) => b.textContent.includes('Entrar a Batea')), { timeout: 40000 })
ok('importó solo esa carpeta y ofrece «Entrar a Batea»', (await j(A + 'api/status')).library_tracks === 1)
ok('la búsqueda automática quedó apagada (eligió solo una carpeta)', (await j(A + 'api/status')).autodiscover === false)
for (const b of await p.$$('.wl-cta')) { if ((await b.evaluate((e) => e.textContent)).includes('Entrar a Batea')) { await b.click(); break } }
await p.waitForSelector('.sidebar', { timeout: 10000 }); await sleep(1000)
ok('entra a Bateas con el tema cargado', /1 discos/.test(await p.$eval('.viewhead .sub', (e) => e.textContent).catch(() => '')))
ok('el motor recordó que ya se vio', (await j(A + 'api/status')).welcome_done === true)

console.log('B) interruptor de búsqueda automática en «Analizar e importar»')
await clickText(p, '.nav button', 'Analizar e importar'); await p.waitForSelector('.fm-auto input', { timeout: 8000 })
ok('arranca apagado', (await p.$eval('.fm-auto input', (e) => e.checked)) === false)
await p.click('.fm-auto input'); await sleep(800)
ok('al encenderlo el motor lo guarda', (await j(A + 'api/status')).autodiscover === true)
await p.click('.fm-auto input'); await sleep(800)
ok('al apagarlo también', (await j(A + 'api/status')).autodiscover === false)

console.log('C) repetir la presentación y reabrir')
await p.evaluate(() => window.__batea.useApp.getState().setSettings('about')); await p.waitForSelector('.settings-about', { timeout: 5000 })
await clickText(p, '.settings-about button', 'Ver la presentación'); await p.waitForSelector('.welcome', { timeout: 5000 })
ok('modo repetición: sin pregunta ni panel de carga', !(await p.$('.setup')) && !(await p.$('.wl-load')) && !!(await p.$('.wl-replay')))
await p.keyboard.press('Escape'); await p.waitForSelector('.sidebar', { timeout: 5000 })
await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForSelector('.sidebar', { timeout: 10000 }); await sleep(1200)
ok('al reabrir no vuelve a aparecer', !(await p.evaluate(() => window.__seen)).welcome)
await p.close()

console.log('D) «Entrar sin importar nada» (otra instalación nueva)')
p = await open(C); await p.waitForSelector('.setup', { timeout: 15000 })
await p.click('.su-foot .wl-cta'); await p.waitForSelector('.sidebar', { timeout: 10000 }); await sleep(800)
seen = await p.evaluate(() => window.__seen)
ok('entra directo a la app', seen.sidebar && !(await p.$('.welcome')))
ok('no se mostraron las diapositivas', !seen.stage)
const stC = await j(C + 'api/status')
ok('no importó ni buscó nada y quedó anotado', stC.library_tracks === 0 && stC.welcome_done === true && stC.autodiscover === false && (await j(C + 'api/jobs')).length === 0)
await p.close()

console.log('E) usuario que ya tiene temas (nunca vio la presentación)')
const st = await j(B + 'api/status')
ok('preparación: tiene temas y welcome_done=false', st.library_tracks > 0 && st.welcome_done === false, `${st.library_tracks} temas`)
ok('para ese usuario la búsqueda automática sigue como antes (activada)', st.autodiscover === true)
p = await open(B); await p.waitForSelector('.sidebar', { timeout: 15000 }); await sleep(1500)
seen = await p.evaluate(() => window.__seen)
ok('entra directo a la app, sin bienvenida ni pregunta', seen.sidebar && !seen.welcome)
await p.close()

await browser.close()
console.log(fails ? `\n${fails} FALLA(S)` : '\nTODO BIEN')
process.exit(fails ? 1 : 0)
