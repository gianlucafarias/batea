import type { ReactNode } from 'react'
import { BrandMark, IconChevron, IconCheck, IconCrate, IconFolder, IconGrid, IconMix, IconPlay, IconSpark, IconTag } from '../src/components/icons'
import logoRekordbox from '../src/assets/logos/rekordbox.png'
import logoTraktor from '../src/assets/logos/traktor.png'
import logoSerato from '../src/assets/logos/serato.png'
import shotBateas from './shots/app-bateas.webp'
import shotCaja from './shots/app-caja.webp'
import shotMezcla from './shots/app-mezcla.webp'
import { BetaForm } from './BetaForm'

const REPO = 'https://github.com/gianlucafarias/batea'

const IconWave = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
  </svg>
)
const IconLive = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
  </svg>
)
const IconClock = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
)
const IconApple = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9s-1.8-.8-3-.8c-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.2.8 1.1 1.700 2.400 2.900 2.300 1.200 0 1.600-.8 3-.8s1.800.8 3 .7c1.200 0 2-1.100 2.800-2.200.9-1.300 1.200-2.500 1.200-2.600 0 0-2.400-.9-2.400-3.700zM14.100 5.800c.600-.8 1.100-1.800.9-2.800-.9 0-2 .6-2.600 1.400-.6.700-1.100 1.700-.9 2.700 1 .1 2-.5 2.600-1.300z" />
  </svg>
)
const IconSmallCrate = () => <IconCrate size={22} />

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <li className="lp-chip">{icon}<span>{children}</span></li>
}

function Window({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  return (
    <figure className={`lp-window ${className}`}>
      <img src={src} alt={alt} decoding="async" />
    </figure>
  )
}

/** El menú de la barra de arriba (menubar.py): qué suena y qué poner después. Los temas y razones salen del motor de recomendaciones con una biblioteca de prueba. */
function MenubarPanel() {
  const recs = [
    { t: 'Sub Tierra', m: 'Lunar · 127 BPM · 9A · energía 7', why: 'ya los mezclaste' },
    { t: 'Cobre', m: 'Aurora Sur · 126 BPM · 8A · energía 7', why: 'mismo tono' },
    { t: 'Luz rasante', m: 'Nodo Sur · 128 BPM · 9B · energía 7', why: 'energía parecida' },
  ]
  return (
    <div className="lp-menubar" role="img" aria-label="Menú de Batea en la barra de macOS: suena Medianoche y sugiere Sub Tierra, Cobre y Luz rasante">
      <p className="lp-mb-h">SONANDO AHORA <span>·</span> cargado en un deck</p>
      <p className="lp-mb-t">Medianoche</p>
      <p className="lp-mb-m">Ciclo 9 · 126 BPM · 8A · energía 7</p>
      <p className="lp-mb-h lp-mb-h2">PARA PONER DESPUÉS <span>·</span> arrastrá un tema al deck</p>
      <ul>
        {recs.map((r) => (
          <li key={r.t}><b>{r.t}</b><span>{r.m} · {r.why}</span></li>
        ))}
      </ul>
    </div>
  )
}

export function Landing() {
  return (
    <div className="landing">
      <div className="lp-announce">
        <p><IconSpark size={14} aria-hidden /> Ahora Batea está en beta abierta para Mac. Probala y contanos qué te parece.</p>
        <a href="#beta">Sumate a la beta <IconChevron size={13} aria-hidden /></a>
      </div>

      <header className="lp-nav">
        <a className="brand" href="#inicio"><BrandMark /><span className="brand-name">batea</span></a>
        <nav aria-label="Principal">
          <a href="#producto">Producto</a>
          <a href="#herramientas">Herramientas</a>
          <a href="#integraciones">Integraciones</a>
          <a href={REPO}>Comunidad</a>
        </nav>
        <div className="lp-nav-end">
          <a className="lp-nav-link" href="#producto">Cómo funciona</a>
          <a className="btn primary" href="#beta">Anotate a la beta <IconChevron size={14} aria-hidden /></a>
        </div>
      </header>

      <main>
        <section className="lp-hero" aria-labelledby="landing-title">
          <div className="lp-hero-copy">
            <h1 id="landing-title">De la batea<br />a la cabina</h1>
            <p>Prepará tus sets en tu Mac. Ordená tu música, probá las transiciones y encontrá qué poner después mientras tocás.</p>
            <div className="lp-cta">
              <a className="btn primary lp-btn" href="#beta">Anotate a la beta <IconChevron size={15} aria-hidden /></a>
              <a className="btn lp-btn" href="#producto"><IconPlay size={14} aria-hidden /> Ver cómo funciona</a>
            </div>
            <p className="lp-platform"><IconApple /> Para macOS</p>
          </div>
          <div className="lp-laptop">
            <div className="lp-screen"><img src={shotBateas} alt="Batea: la pantalla de Bateas con las cajas de la librería" decoding="async" fetchPriority="high" /></div>
            <div className="lp-base" aria-hidden />
          </div>
        </section>

        <section id="integraciones" className="lp-sources" aria-label="Software de DJ compatible">
          <p>Compatible con</p>
          <div>
            <img src={logoRekordbox} alt="rekordbox" />
            <img src={logoTraktor} alt="Traktor" />
            <img src={logoSerato} alt="Serato" />
          </div>
        </section>

        <section id="producto" className="lp-feature lp-feature-a" aria-labelledby="f1">
          <Window src={shotCaja} alt="Batea: una caja abierta con sus discos y la ficha del tema elegido" />
          <div className="lp-copy">
            <span className="lp-ico"><IconCrate size={26} /></span>
            <h2 id="f1">Organizá tu música<br />con bateas</h2>
            <p>Ordená tu librería como pensás un set: en bateas, con cajas, mapas y atajos que se adaptan a tu forma de tocar.</p>
            <ul className="lp-chips">
              <Chip icon={<IconSmallCrate />}>Bateas y cajas</Chip>
              <Chip icon={<IconSpark size={16} />}>Atajos rápidos</Chip>
              <Chip icon={<IconGrid size={16} />}>Tu librería, a tu modo</Chip>
            </ul>
          </div>
        </section>

        <section className="lp-feature lp-feature-b" aria-labelledby="f2">
          <div className="lp-copy">
            <span className="lp-ico"><IconWave size={26} /></span>
            <h2 id="f2">Probá la mezcla<br />antes de tocar</h2>
            <p>Analizá la compatibilidad entre temas, visualizá la transición y ajustá la mezcla con herramientas de nivel de cabina.</p>
            <ul className="lp-checks">
              <li><IconCheck size={15} aria-hidden /> Análisis de energía y tonalidad</li>
              <li><IconCheck size={15} aria-hidden /> Visualización de la mezcla</li>
              <li><IconCheck size={15} aria-hidden /> Ajustes precisos de transición</li>
            </ul>
          </div>
          <Window src={shotMezcla} alt="Probar mezcla: dos temas alineados por compases con crossfader, EQ y curvas" className="lp-window-mix" />
        </section>

        <section className="lp-feature lp-feature-c" aria-labelledby="f3">
          <MenubarPanel />
          <div className="lp-copy">
            <span className="lp-ico"><IconLive size={26} /></span>
            <h2 id="f3">Recomendaciones<br />en vivo mientras tocás</h2>
            <p>Batea detecta el tema que suena y te sugiere qué poner después según BPM, tonalidad, energía y tu historial.</p>
            <ul className="lp-chips">
              <Chip icon={<IconLive size={16} />}>Sugerencias en tiempo real</Chip>
              <Chip icon={<IconGrid size={16} />}>Compatible con tu mezcla</Chip>
              <Chip icon={<IconClock />}>Aprende de tu estilo</Chip>
            </ul>
          </div>
        </section>

        <section id="herramientas" className="lp-tools" aria-labelledby="tools-title">
          <h2 id="tools-title">Más herramientas para preparar tus sets</h2>
          <p>Todo lo que necesitás para buscar, organizar y descubrir música, en un solo lugar.</p>
          <ul>
            <li>
              <IconTag size={24} aria-hidden />
              <h3>Etiquetas rápidas</h3>
              <p>Etiquetá varios temas con el teclado. Marcá la energía, el puntaje, las intros o las acapelas.</p>
            </li>
            <li>
              <IconWave size={24} />
              <h3>Cues y grillas</h3>
              <p>Editá hot cues, loops y el inicio de cada compás para ajustar tus transiciones.</p>
            </li>
            <li>
              <IconFolder size={24} aria-hidden />
              <h3>Universos</h3>
              <p>Agrupá playlists y carpetas por estilo o evento. El mapa y las sugerencias se ajustan a esa selección.</p>
            </li>
            <li>
              <IconMix size={24} aria-hidden />
              <h3>Tu biblioteca con IA</h3>
              <p>Conectá Claude, Codex o Cursor para buscar temas compatibles o consultar el historial de sets.</p>
            </li>
          </ul>
        </section>

        <section id="beta" className="lp-beta" aria-labelledby="beta-title">
          <div>
            <h2 id="beta-title">Anotate a la<br />beta de Batea</h2>
            <p>Probá Batea en tu Mac, prepará mejores sets y ayudanos a seguir mejorándola.</p>
          </div>
          <BetaForm />
        </section>
      </main>

      <footer className="lp-footer">
        <a className="brand" href="#inicio"><BrandMark /><span className="brand-name">batea</span></a>
        <nav aria-label="Pie">
          <a href={REPO}>Comunidad</a>
          <a href={`${REPO}/issues`}>Ayuda</a>
          <a href="#beta">Contacto</a>
        </nav>
      </footer>
    </div>
  )
}
