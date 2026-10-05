import { createRoot } from 'react-dom/client'
import '@renderer/styles/base.css'
import './settings.css'
import '../bridge'
import { MobileSettings } from './MobileSettings'

createRoot(document.getElementById('root')!).render(<MobileSettings />)
