import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../base.css'

import { App } from './App'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('im: #root is missing from index.html')
}

/**
 * Which conversation this window is for. Main passes it as a query parameter when it creates
 * the window (see createImWindow in src/main/index.ts) — one IM window per conversation, so
 * the identity has to arrive with the document, not over IPC after the fact.
 */
const conversationId = new URLSearchParams(window.location.search).get('conversationId')

createRoot(container).render(
  <StrictMode>
    <App conversationId={conversationId} />
  </StrictMode>,
)
