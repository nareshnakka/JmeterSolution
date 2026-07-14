import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Buffer } from 'buffer'
import App from './App'
import './index.css'

// ExcelJS (xlsx write) expects Buffer in the browser.
;(window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  ;(globalThis as { Buffer: typeof Buffer }).Buffer = Buffer
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
