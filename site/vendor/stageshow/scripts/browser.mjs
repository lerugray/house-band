// The headless browser the filming scripts share. playwright-core is the one
// dependency filming needs and the kit doesn't, so a missing install says how
// to fix it rather than failing on the import. Chrome is the installed one
// (CHROME_PATH overrides), found on macOS, Windows and Linux alike.
export async function launch() {
  let chromium
  try {
    ;({ chromium } = await import('playwright-core'))
  } catch {
    console.error('Filming needs playwright-core: run `npm i -D playwright-core` (or pnpm/yarn) in this project, then try again.')
    process.exit(2)
  }
  const path = process.env.CHROME_PATH
  try {
    // CHROME_ARGS (space-separated) adds launch flags, e.g. --mute-audio.
    const args = (process.env.CHROME_ARGS || '').split(/\s+/).filter(Boolean)
    return await chromium.launch(path ? { executablePath: path, args } : { channel: 'chrome', args })
  } catch {
    console.error(`Couldn't start Chrome${path ? ` at ${path}` : ''}. Install Google Chrome, or set CHROME_PATH to a Chrome or Chromium binary.`)
    process.exit(2)
  }
}

// Lazy-mounted hosts (an IntersectionObserver that mounts a stage on scroll)
// never show a stage to a page that sits at the top. FILM_SCROLL=<selector>
// scrolls each match into view in turn (400 ms apart) after load, so the last
// match ends centred. No effect when the variable is unset.
export async function scrollInit(page) {
  const sel = process.env.FILM_SCROLL
  if (!sel) return
  await page.addInitScript(`(() => {
    const sel = ${JSON.stringify(sel)}
    const go = () => {
      const els = [...document.querySelectorAll(sel)]
      els.forEach((el, i) => setTimeout(() => el.scrollIntoView({ block: 'center' }), i * 400))
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go)
    else go()
  })()`)
}
