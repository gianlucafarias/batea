import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'

/**
 * Un solo resaltado por lista que se desliza de fila en fila bajo el mouse (Fluid Hover, hecho a mano
 * porque Batea no usa Tailwind ni shadcn). Uso:
 *
 *   const fh = useFluidHover<HTMLElement>()
 *   <nav ref={fh.ref}>{fh.highlight} <button data-fh>…</button> … </nav>
 *
 * - Solo se marcan con `data-fh` las filas que se pueden clickear (un resaltado promete un click).
 * - Las filas tienen que tocarse (sin gap): un hueco apaga el resaltado y el siguiente aparece en su lugar,
 *   sin cruzar la pantalla.
 * - La fila bajo el mouse recibe `data-hover`, para que el CSS levante el color del texto.
 * - El movimiento es solo `transform` (rápido, 80 ms) y la aparición solo `opacity`; ver .fh-hl en styles.css.
 */
export function useFluidHover<T extends HTMLElement = HTMLDivElement>(): { ref: (el: T | null) => void; highlight: ReactElement } {
  const [el, setEl] = useState<T | null>(null)
  const hl = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = el
    const mark = hl.current
    if (!box || !mark) return
    box.setAttribute('data-fh-root', '')
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative'

    let cur: HTMLElement | null = null
    let shown = false
    let lx = 0
    let ly = 0

    // la fila de ESTA lista bajo el puntero (desde un submenú se sube hasta la fila que lo abrió)
    const itemAt = (t: EventTarget | null): HTMLElement | null => {
      let it = (t instanceof Element ? t : null)?.closest<HTMLElement>('[data-fh]') ?? null
      while (it && it.closest('[data-fh-root]') !== box) it = it.parentElement?.closest<HTMLElement>('[data-fh]') ?? null
      return it && box.contains(it) ? it : null
    }

    const place = (it: HTMLElement) => {
      const b = box.getBoundingClientRect()
      const r = it.getBoundingClientRect()
      const x = r.left - b.left - box.clientLeft + box.scrollLeft
      const y = r.top - b.top - box.clientTop + box.scrollTop
      mark.style.width = `${r.width}px`
      mark.style.height = `${r.height}px`
      const to = `translate3d(${x}px, ${y}px, 0)`
      if (!shown) {
        // entra desde afuera o desde un hueco: aparece donde cae, sin deslizarse
        mark.style.transition = 'none'
        mark.style.transform = to
        void mark.offsetWidth
        mark.style.transition = ''
        mark.setAttribute('data-on', '')
        shown = true
      } else if (mark.style.transform !== to) {
        mark.style.transform = to
      }
    }

    const update = (t: EventTarget | null) => {
      const it = itemAt(t)
      if (it !== cur) {
        cur?.removeAttribute('data-hover')
        cur = it
        cur?.setAttribute('data-hover', '')
      }
      if (it) place(it)
      else if (shown) { shown = false; mark.removeAttribute('data-on') }
    }

    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      lx = e.clientX; ly = e.clientY
      update(e.target)
    }
    const leave = () => update(null)
    // al scrollear (la lista o algo que la contiene) la fila bajo el mouse cambia sin que el mouse se mueva
    const scroll = () => { if (cur) update(document.elementFromPoint(lx, ly)) }

    box.addEventListener('pointermove', move)
    box.addEventListener('pointerleave', leave)
    document.addEventListener('scroll', scroll, { capture: true, passive: true })
    return () => {
      box.removeEventListener('pointermove', move)
      box.removeEventListener('pointerleave', leave)
      document.removeEventListener('scroll', scroll, { capture: true })
      cur?.removeAttribute('data-hover')
    }
  }, [el])

  return { ref: setEl, highlight: <div className="fh-hl" ref={hl} aria-hidden /> }
}

/** Contenedor de lista con su resaltado, para los casos simples (las filas clickeables llevan `data-fh`). */
export function HoverList({ className, style, children }: { className?: string; style?: CSSProperties; children: ReactNode }) {
  const fh = useFluidHover<HTMLDivElement>()
  return <div ref={fh.ref} className={className} style={style}>{fh.highlight}{children}</div>
}

/** Play ↔ pausa (o cualquier par de íconos) cruzándose en la misma celda. */
export function GlyphSwap({ on, a, b }: { on: boolean; a: ReactNode; b: ReactNode }) {
  return (
    <span className="icon-swap">
      <span data-off={on ? '' : undefined}>{a}</span>
      <span data-off={on ? undefined : ''}>{b}</span>
    </span>
  )
}
