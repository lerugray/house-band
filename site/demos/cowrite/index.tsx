import { createRoot, type Root } from 'react-dom/client'
import CowriteDemo from './CowriteDemo'
import './cowrite.css'

declare global {
  interface Window {
    __hbCowriteRoot?: Root
  }
}

/** Mount the co-write demo into el. Idempotent for a given element. */
export function mountCowriteDemo(el: HTMLElement) {
  if (el.dataset.hbMounted === '1') return
  el.dataset.hbMounted = '1'
  const root = createRoot(el)
  window.__hbCowriteRoot = root
  root.render(<CowriteDemo />)
}

const auto = document.querySelector<HTMLElement>('[data-demo="cowrite"]')
if (auto) mountCowriteDemo(auto)

export default CowriteDemo
