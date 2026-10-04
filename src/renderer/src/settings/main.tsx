import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import './settings.css'
import './engine.css'
import { Settings } from './Settings'

createRoot(document.getElementById('root')!).render(<Settings />)
