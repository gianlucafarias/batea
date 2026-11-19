import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { useFluidHover } from '../lib/fluidHover'
import { spring, usePresence } from '../lib/motion'

// ------------------------------------------------------------------ piezas
export function Item({ children, onClick, disabled, hint, danger, sub }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; hint?: string; danger?: boolean; sub?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(false)
  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setLeft(r.right + 220 > window.innerWidth)
  }, [open])
  return (
    <div ref={ref} data-fh={disabled ? undefined : ''} className={`cm-item${disabled ? ' off' : ''}${danger ? ' danger' : ''}${sub ? ' has-sub' : ''}`} title={hint}
      onMouseEnter={() => sub && setOpen(true)} onMouseLeave={() => sub && setOpen(false)}
      onClick={() => { if (!disabled && onClick) onClick() }}>
      <span>{children}</span>
      {sub && <span className="cm-arrow">›</span>}
      {sub && open && !disabled && <SubMenu left={left}>{sub}</SubMenu>}
    </div>
  )
}
function SubMenu({ left, children }: { left: boolean; children: ReactNode }) {
  const fh = useFluidHover<HTMLDivElement>()
  return <div ref={fh.ref} className={`cm cm-sub${left ? ' left' : ''}`}>{fh.highlight}{children}</div>
}
export const Sep = () => <div className="cm-sep" />


// ------------------------------------------------------------------ envoltorio
/**
 * Caja flotante del menú: se coloca donde se hizo click sin salirse de la ventana, se cierra con click afuera,
 * Escape, scroll o al perder el foco, y se desvanece rápido con su último contenido.
 */
export function MenuShell<T extends { x: number; y: number }>({ live, close, children }: {
  live: T | null
  close: () => void
  children: (menu: T) => ReactNode
}) {
  const [menu, closing] = usePresence(live, spring.fast.exit)
  const ref = useRef<HTMLDivElement | null>(null)
  const { ref: hoverRef, highlight } = useFluidHover<HTMLDivElement>()
  const setRef = useCallback((el: HTMLDivElement | null) => { ref.current = el; hoverRef(el) }, [hoverRef])
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!live) return
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const wheel = () => close()
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    window.addEventListener('wheel', wheel, { passive: true })
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key)
      window.removeEventListener('wheel', wheel); window.removeEventListener('blur', close)
    }
  }, [live, close])

  // que no se salga de la ventana (al cerrarse queda donde estaba)
  useLayoutEffect(() => {
    if (!live) return
    if (!ref.current) { setPos(null); return }
    const r = ref.current.getBoundingClientRect()
    setPos({ x: Math.min(live.x, window.innerWidth - r.width - 8), y: Math.min(live.y, window.innerHeight - r.height - 8) })
  }, [live])

  if (!menu) return null
  return (
    <div ref={setRef} className={`cm${closing ? ' closing' : ''}`} style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}>
      {highlight}
      {children(menu)}
    </div>
  )
}

// ------------------------------------------------------------------ menú genérico
interface PopState {
  menu: { x: number; y: number; head: string; items: (close: () => void) => ReactNode } | null
  open: (m: NonNullable<PopState['menu']>) => void
  close: () => void
}
const usePop = create<PopState>((set) => ({ menu: null, open: (menu) => set({ menu }), close: () => set({ menu: null }) }))

/** Click derecho con un menú armado por quien llama: `items` recibe `close` para cerrarlo antes de actuar. */
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void },
  head: string, items: (close: () => void) => ReactNode) {
  e.preventDefault()
  e.stopPropagation()
  usePop.getState().open({ x: e.clientX, y: e.clientY, head, items })
}

export function PopMenu() {
  const { menu, close } = usePop()
  return <MenuShell live={menu} close={close}>{(m) => (
    <>
      <div className="cm-head ellipsis">{m.head}</div>
      {m.items(close)}
    </>
  )}</MenuShell>
}
