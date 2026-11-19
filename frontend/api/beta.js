import { JWT } from 'google-auth-library'

const action = 'batea_beta'
const emailPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i
let sheetsClient

function requestHostname(headers) {
  try {
    const origin = new URL(headers.origin)
    if (origin.host === headers.host && ['https:', 'http:'].includes(origin.protocol)) {
      return origin.hostname
    }
  } catch {
    return undefined
  }
}

async function verifyChallenge(secret, token, hostname) {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret, response: token }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error('Turnstile unavailable')
  const result = await response.json()
  return result.success === true && result.hostname === hostname && result.action === action
}

async function appendSignup(spreadsheetId, credentials, email) {
  if (!sheetsClient) {
    const { client_email, private_key } = JSON.parse(credentials)
    if (!client_email || !private_key) throw new Error('Missing service account credentials')
    sheetsClient = new JWT({
      email: client_email,
      key: private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
  }
  const { token } = await sheetsClient.getAccessToken()
  if (!token) throw new Error('Missing Google access token')

  const range = encodeURIComponent('Solicitudes!A:B')
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}:append`
  const response = await fetch(`${url}?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[new Date().toISOString(), email]] }),
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error('Google Sheets append failed')
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method' })
  }
  const hostname = requestHostname(req.headers)
  if (!hostname) return res.status(403).json({ error: 'origin' })
  if (Number(req.headers['content-length']) > 8192) {
    return res.status(413).json({ error: 'request' })
  }
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return res.status(415).json({ error: 'request' })
  }

  const { email, token } = req.body ?? {}
  const address = typeof email === 'string' ? email.trim() : ''
  if (address.length > 254 || address.split('@')[0].length > 64 || !emailPattern.test(address)) {
    return res.status(400).json({ error: 'email' })
  }
  if (typeof token !== 'string' || token.length < 1 || token.length > 2048) {
    return res.status(400).json({ error: 'verification' })
  }

  const { TURNSTILE_SECRET_KEY, GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON } = process.env
  if (!TURNSTILE_SECRET_KEY || !GOOGLE_SHEETS_SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) {
    return res.status(503).json({ error: 'unavailable' })
  }
  try {
    if (!(await verifyChallenge(TURNSTILE_SECRET_KEY, token, hostname))) {
      return res.status(403).json({ error: 'verification' })
    }
    await appendSignup(GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON, address)
    return res.status(201).json({ ok: true })
  } catch {
    console.error('Batea beta: no se pudo verificar o guardar la solicitud.')
    return res.status(503).json({ error: 'unavailable' })
  }
}
