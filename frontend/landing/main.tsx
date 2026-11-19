import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/archivo/wdth.css'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/permanent-marker'
import '../src/styles.css'
import './landing.css'
import { Landing } from './Landing'

createRoot(document.getElementById('root')!).render(<StrictMode><Landing /></StrictMode>)
