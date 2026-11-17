import { Fragment } from 'react'
import { useApp } from '../store'
import type { Crate } from '../types'

export const ARTIST = 'artist:'

// "Kuss & Clotur", "A feat. B", "A, B x C" → cada nombre por separado (los separadores se muestran tal cual)
const SEP = /(\s*(?:,|&|\+|\/|;|\s(?:feat\.?|ft\.?|featuring|vs\.?|x|y|and|with)\s)\s*)/i

export function splitArtists(s: string): { name: string; sep: boolean }[] {
  return s.split(SEP).filter((p) => p !== '').map((p) => ({ name: p, sep: SEP.test(p) && p.trim().length < 12 && !/\w{3,}\s+\w/.test(p.trim()) }))
}

/** El artista abierto como si fuera una caja. */
export function artistCrate(crateId: string | null): Crate | undefined {
  if (!crateId?.startsWith(ARTIST)) return undefined
  return { id: crateId, kind: 'artist', name: crateId.slice(ARTIST.length), count: 0 }
}

/** Nombres de artista clickeables: abren todos sus temas (propios, colaboraciones y remixes). */
export function ArtistLinks({ artist, fallback = '' }: { artist: string | null | undefined; fallback?: string }) {
  const goFiltered = useApp((s) => s.goFiltered)
  if (!artist?.trim()) return <>{fallback}</>
  return (
    <>
      {splitArtists(artist).map((p, i) => p.sep || p.name.trim().length < 2
        ? <Fragment key={i}>{p.name}</Fragment>
        : (
          <button key={i} className="artist-link" title={`Ver los temas de ${p.name.trim()}`}
            onClick={(e) => { e.stopPropagation(); goFiltered(ARTIST + p.name.trim(), {}) }}
            onDoubleClick={(e) => e.stopPropagation()}>
            {p.name}
          </button>
        ))}
    </>
  )
}
