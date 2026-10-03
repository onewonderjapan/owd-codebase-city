import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { TRPCProvider } from '@/providers/trpc'
import './styles/kit.css'
import './styles/app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TRPCProvider>
      <App />
    </TRPCProvider>
  </StrictMode>,
)
