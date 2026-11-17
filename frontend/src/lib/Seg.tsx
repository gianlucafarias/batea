import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'

/**
 * Control segmentado (.seg) con el fondo de la opción elegida deslizándose a la nueva, en vez de saltar.
 * Las opciones siguen siendo <button className={on ? 'on' : ''}>: el indicador se ubica solo sobre la que tenga `.on`.
 */
export function Seg({ children, className, style, role }: { children: ReactNode; className?: string; style?: CSSProperties; role?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const ind = useRef<HTMLSpanElement>(null)
  const placed = useRef(false)

  // se mide después de cada render (un solo elemento, offsetLeft no se entera de transforms en curso)
  useLayoutEffect(() => {
    const b = box.current
    const i = ind.current
    if (!b || !i) return
    const on = b.querySelector<HTMLElement>(':scope > button.on')
    if (!on) { i.removeAttribute('data-on'); placed.current = false; return }
    const to = `translate3d(${on.offsetLeft}px, 0, 0)`
    const w = `${on.offsetWidth}px`
    if (!placed.current) {
      i.style.transition = 'none'
      i.style.transform = to
      i.style.width = w
      void i.offsetWidth
      i.style.transition = ''
      placed.current = true
    } else {
      i.style.transform = to
      i.style.width = w
    }
    i.setAttribute('data-on', '')
  })

  return (
    <div className={`seg${className ? ` ${className}` : ''}`} style={style} role={role} ref={box}>
      <span className="seg-ind" ref={ind} aria-hidden />
      {children}
    </div>
  )
}
