import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import './pin.css'
import { Pin } from './Pin'

createRoot(document.getElementById('root')!).render(<Pin />)
