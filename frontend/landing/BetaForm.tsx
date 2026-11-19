import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'
import { IconCheck, IconChevron } from '../src/components/icons'

const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim()
const compactWidget = '(max-width: 390px)'
const messages: Record<string, string> = {
  email: 'Revisá que el correo esté escrito correctamente.',
  verification: 'La verificación venció o falló. Volvé a intentarlo.',
}

export function BetaForm() {
  const widget = useRef<TurnstileInstance>(null)
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [registered, setRegistered] = useState(false)
  const [error, setError] = useState('')
  const [compact, setCompact] = useState(() => window.matchMedia(compactWidget).matches)

  useEffect(() => {
    const media = window.matchMedia(compactWidget)
    function resize(event: MediaQueryListEvent) {
      setToken('')
      setCompact(event.matches)
    }
    media.addEventListener('change', resize)
    return () => media.removeEventListener('change', resize)
  }, [])

  function verificationFailed() {
    setToken('')
    setError('No pudimos iniciar la verificación. Recargá la página para volver a intentar.')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token || submitting) return
    const email = new FormData(event.currentTarget).get('email')
    setError('')
    setSubmitting(true)

    try {
      const response = await fetch('/api/beta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token }),
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 201) {
        setRegistered(true)
        return
      }
      const result = await response.json()
      setError(messages[result.error] ?? 'No pudimos guardar tu solicitud. Volvé a intentarlo.')
    } catch {
      setError('No pudimos guardar tu solicitud. Volvé a intentarlo.')
    } finally {
      setSubmitting(false)
      setToken('')
      widget.current?.reset()
    }
  }

  if (registered) {
    return <p className="landing-success" role="status"><IconCheck size={19} aria-hidden /> Recibimos tu solicitud. Te vamos a contactar por correo.</p>
  }

  return (
    <form className="landing-form" onSubmit={submit}>
      <label htmlFor="beta-email">Correo electrónico</label>
      <div className="landing-fields">
        <input className="input" id="beta-email" type="email" name="email" placeholder="vos@ejemplo.com" autoComplete="email"
          required maxLength={254} aria-describedby="beta-privacy" disabled={submitting || !siteKey} />
        <button className="btn primary wl-cta" disabled={!token || submitting}>
          {submitting ? 'Enviando…' : 'Anotarme'} <IconChevron size={15} aria-hidden />
        </button>
      </div>
      <p id="beta-privacy">Usamos tu correo para avisarte sobre la beta.</p>
      {siteKey ? (
        <Turnstile ref={widget} siteKey={siteKey}
          options={{ theme: 'dark', appearance: 'interaction-only', action: 'batea_beta', size: compact ? 'compact' : 'flexible', language: 'es' }}
          onSuccess={setToken}
          onExpire={() => setToken('')}
          scriptOptions={{ onError: verificationFailed }}
          onError={verificationFailed}
          onUnsupported={verificationFailed}
        />
      ) : <p role="status">Las inscripciones todavía no están abiertas.</p>}
      {error && <p className="landing-error" role="alert">{error}</p>}
    </form>
  )
}
