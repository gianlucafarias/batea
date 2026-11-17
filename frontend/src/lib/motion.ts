import { useEffect, useState } from 'react'

/**
 * Las tres velocidades de movimiento de Batea (sistema Fluid Functionalism), en milisegundos.
 * Las mismas viven en styles.css como --fast / --moderate / --slow, con sus curvas de resorte en --spring-*.
 * Cuanto más grande lo que se mueve, más lento: hover y colores rápido, indicadores y menús moderado,
 * paneles y diálogos lento. Las salidas son un escalón más cortas, para que cerrar se sienta seco.
 */
export const spring = {
  fast: { enter: 80, exit: 60 },
  moderate: { enter: 160, exit: 120 },
  slow: { enter: 240, exit: 160 },
} as const

/**
 * Mantiene montado algo que se está cerrando durante su animación de salida.
 * Devuelve [lo último que hubo, cerrándose]: mientras `closing` es true el valor ya no está,
 * pero se sigue mostrando el último para que la salida se vea con su contenido.
 */
export function usePresence<T>(value: T | null | undefined | false, exitMs: number): [T | null, boolean] {
  const present = value !== null && value !== undefined && value !== false
  const [state, setState] = useState<{ item: T | null; closing: boolean }>({ item: present ? (value as T) : null, closing: false })
  // ajuste durante el render (patrón de React para estado derivado): sin un cuadro de más con el valor viejo
  if (present && (state.item !== value || state.closing)) setState({ item: value as T, closing: false })
  else if (!present && state.item !== null && !state.closing) setState({ item: state.item, closing: true })
  useEffect(() => {
    if (!state.closing) return
    const t = window.setTimeout(() => setState({ item: null, closing: false }), exitMs)
    return () => window.clearTimeout(t)
  }, [state.closing, exitMs])
  return [state.item, state.closing]
}
