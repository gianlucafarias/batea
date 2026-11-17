import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
})

export const IconCrate = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 10h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M7 10V5M10.5 10V4M14 10V5.5M17.5 10V4.5" /><path d="M10 14h4" /></svg>
)
export const IconMap = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="6" cy="16" r="1.6" /><circle cx="11" cy="9" r="1.6" /><circle cx="17" cy="13" r="1.6" /><circle cx="18" cy="6" r="1.2" /><path d="M7.3 14.8 10 10.4M12.4 9.8l3.4 2.4" /><path d="M3 21h18M3 21V3" /></svg>
)
export const IconInbox = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" /></svg>
)
export const IconPlay = ({ size, ...p }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none" {...p}><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
)
export const IconPause = ({ size, ...p }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none" {...p}><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
)
export const IconSearch = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
)
export const IconX = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>
)
export const IconPlus = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 5v14M5 12h14" /></svg>
)
export const IconSync = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 20v-4h-4" /></svg>
)
export const IconExport = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 15V3M7 8l5-5 5 5" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>
)
export const IconFilter = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 6h16M7 12h10M10 18h4" /></svg>
)
export const IconEye = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
)
export const IconEyeOff = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
)
export const IconChevron = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="m9 6 6 6-6 6" /></svg>
)
export const IconLink = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
)
export const IconThumbUp = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M7 10v10H4V10zM7 10l4-7a2 2 0 0 1 2.6 2.2L13 9h6a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.7 20H7" /></svg>
)
export const IconThumbDown = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M17 14V4h3v10zM17 14l-4 7a2 2 0 0 1-2.6-2.2L11 15H5a2 2 0 0 1-2-2.3l1.3-7A2 2 0 0 1 6.3 4H17" /></svg>
)
export const IconFolder = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
)
export const IconGrid = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></svg>
)
export const IconList = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>
)
export const IconVolume = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16.5 8.5a5 5 0 0 1 0 7" /></svg>
)
export const IconSpark = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" /></svg>
)
export const IconFinder = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M14 4h6v6M20 4l-8 8" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
)

export const IconTag = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M3 12.6V4h8.6l9 9a1.4 1.4 0 0 1 0 2l-6.6 6.6a1.4 1.4 0 0 1-2 0z" /><circle cx="7.6" cy="8.6" r="1.3" /></svg>
)
export const IconMix = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="8.5" cy="12" r="5.5" /><circle cx="15.5" cy="12" r="5.5" /></svg>
)
export const IconCheck = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
)
export const IconPencil = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>
)
export const IconSwap = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M7 4 3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7" /></svg>
)

export const BrandMark = () => (
  <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
    <rect x="3" y="15" width="26" height="14" rx="2.5" fill="#2b2622" stroke="#4a423a" />
    <rect x="7" y="5" width="18" height="16" rx="1.5" fill="#ff5a1f" transform="rotate(-6 16 13)" />
    <circle cx="16" cy="12.6" r="4.2" fill="#0e0d0c" transform="rotate(-6 16 13)" />
    <circle cx="16" cy="12.6" r="1.1" fill="#ff5a1f" />
    <rect x="12" y="19" width="8" height="2.4" rx="1.2" fill="#0e0d0c" />
  </svg>
)
