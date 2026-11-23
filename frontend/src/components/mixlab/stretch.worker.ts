import { stretch } from './stretch'

self.onmessage = (event: MessageEvent<{ channels: Float32Array[]; sampleRate: number; rate: number }>) => {
  const { channels, sampleRate, rate } = event.data
  const out = stretch(channels, sampleRate, rate)
  ;(self as unknown as Worker).postMessage(out, out.map((c) => c.buffer))
}
