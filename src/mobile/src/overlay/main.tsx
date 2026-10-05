import { createRoot } from 'react-dom/client'
import '@renderer/styles/base.css'
import './overlay.css'
import '../bridge'
import { MobileOverlay } from './MobileOverlay'

createRoot(document.getElementById('root')!).render(<MobileOverlay />)
