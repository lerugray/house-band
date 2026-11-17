import { createRoot, type Root } from 'react-dom/client'
import SamplesDemo from './SamplesDemo'
import './samples.css'

declare global {
  interface Window {
    __hbSamplesRoot?: Root
  }
}

/** Mount the samples demo into el. Idempotent for a given element. */
export function mountSamplesDemo(el: HTMLElement) {
  if (el.dataset.hbMounted === '1') return
  el.dataset.hbMounted = '1'
  const root = createRoot(el)
  window.__hbSamplesRoot = root
  root.render(<SamplesDemo />)
}

const auto = document.querySelector<HTMLElement>('[data-demo="samples"]')
if (auto) mountSamplesDemo(auto)

export default SamplesDemo
