import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Folder } from 'lucide-react'
import { Stage } from '../../vendor/stageshow/kit/stage'
import type { Act } from '../../vendor/stageshow/kit/act'
import type { LookTokens } from '../../vendor/stageshow/kit/stage'
import { Window, Caret } from '../../vendor/stageshow/kit/window'
import { Meter } from '../../vendor/stageshow/kit/parts/Meter'
import type { Point } from '../../vendor/stageshow/kit/measure'
import './samples.css'

// Bring your own samples: a folder drops onto a terminal-style window, the role
// grid fills in blue (yours), two roles stay grey with the tr808 fallback, then
// a render bar completes and a waveform holds. Gold look: examples/dark-hero
// (depth from surface steps on black, one lit colour). Drop motion: examples/upload.
// Strings: PLAN.md (b) report format / OSS-11 output. Tokens: OSS-25 House Band.

const SCAN = 'house-band samples scan ~/Samples/MyDrums'
const RENDER = 'house-band render song.json --kit-map tr707=user:my-drums'

const MAPPED = [
  'MAPPED kick.a <- Kicks/BD Tight.wav',
  'MAPPED snare.a <- Snares/SN 01.wav',
  'MAPPED hat.closed <- Hats/CH.wav',
  'MAPPED hat.open <- Hats/OH.wav',
  'MAPPED clap <- Claps/Clap 2.wav',
] as const

const UNMAPPED = [
  'UNMAPPED tomLow (falls back to tr808)',
  'UNMAPPED ride (falls back to tr808)',
] as const

type Ghost = { on: boolean; dropped: boolean; leaving: boolean; off: Point; at: Point }

type S = {
  ghost: Ghost
  scan: string
  mapped: number
  unmapped: boolean
  renderCmd: string
  progress: number
  done: boolean
}

const ghostOff: Ghost = { on: false, dropped: false, leaving: false, off: { x: 0, y: 0 }, at: { x: 0, y: 0 } }
const initial: S = {
  ghost: ghostOff,
  scan: '',
  mapped: 0,
  unmapped: false,
  renderCmd: '',
  progress: 0,
  done: false,
}

const poster: S = {
  ghost: { ...ghostOff, dropped: true },
  scan: SCAN,
  mapped: MAPPED.length,
  unmapped: true,
  renderCmd: RENDER,
  progress: 1,
  done: true,
}

/** House Band landing tokens (site/styles.css :root), not Stageshow's Radix look. */
const HB_LOOK: LookTokens = {
  '--ss-canvas': '#0d0f12',
  '--ss-surface': '#161a20',
  '--ss-chrome': '#1d222a',
  '--ss-well': '#0d0f12',
  '--ss-raised': '#1d222a',
  '--ss-line': '#2a3038',
  '--ss-line-faint': '#2a3038',
  '--ss-text-strong': '#ece8e1',
  '--ss-text': '#ece8e1',
  '--ss-text-faint': '#9aa0a6',
  '--ss-icon': '#9aa0a6',
  '--ss-icon-faint': '#9aa0a6',
  '--ss-accent': '#f2b544',
  '--ss-accent-2': '#f2b544',
  '--ss-accent-soft': 'rgba(242, 181, 68, 0.14)',
  '--ss-accent-text': '#f2b544',
  '--ss-font': 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  '--ss-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  '--ss-radius-sm': '6px',
  '--ss-radius-md': '8px',
  '--ss-radius-lg': '10px',
  '--ss-radius-window': '10px',
  '--ss-ink-1': 'rgba(236, 232, 225, 0.1)',
  '--ss-ink-2': 'rgba(236, 232, 225, 0.075)',
  '--ss-ink-3': 'rgba(236, 232, 225, 0.055)',
  '--ss-ink-4': 'rgba(236, 232, 225, 0.04)',
  '--ss-ink-5': 'rgba(236, 232, 225, 0.028)',
  '--ss-term-path': '#9aa0a6',
  '--ss-term-sigil': '#f2b544',
}

async function script(a: Act<S>) {
  await a.wait(280)

  // Beat 1 (0-2 s): folder chip slides in from the left and drops; scan types.
  a.mark('drop')
  const icon = a.rect('desk-icon')
  const file = a.rect('desk-file')
  const grab = { x: icon.x + icon.width / 2, y: icon.y + icon.height * 0.55 }
  await a.move(grab, { duration: 420 })
  await a.wait(120)
  const off = { x: grab.x - file.x, y: grab.y - file.y }
  const drop = a.rect('drop')
  await a.drag(
    { x: drop.x + drop.width * 0.42, y: drop.y + drop.height * 0.28 },
    (at) => {
      a.put({ ghost: { on: true, dropped: false, leaving: false, off, at } })
    },
    { duration: 900, cursor: 'preserve' },
  )
  a.mark('scan')
  await a.set((s) => ({ ghost: { ...s.ghost, dropped: true, on: true } }))
  await a.wait(180)
  await a.type('scan', SCAN, { interval: 22 })
  await a.wait(200)

  // Beat 2 (2-6 s): role grid fills top to bottom in --yours blue.
  a.mark('map')
  for (let i = 1; i <= MAPPED.length; i++) {
    a.put({ mapped: i })
    await a.wait(780)
  }

  // Beat 3 (6-8 s): two cells stay grey with UNMAPPED fallback lines.
  a.mark('unmapped')
  a.put({ unmapped: true })
  await a.wait(2000)

  // Beat 4 (8-11 s): render command, amber bar, waveform payoff.
  a.mark('render')
  await a.type('renderCmd', RENDER, { interval: 18 })
  await a.wait(120)
  for (const [p, ms] of [
    [0.28, 420],
    [0.55, 420],
    [0.82, 420],
    [1, 380],
  ] as const) {
    a.put({ progress: p })
    await a.wait(ms)
  }
  a.mark('payoff')
  a.put({ done: true })
  await a.wait(1600)

  // Loop reset with a visible cause: the folder chip leaves to the left.
  a.mark('leave')
  const leaveFrom = a.center('drop')
  const leaveOff = { x: 44, y: 18 }
  a.put({
    ghost: {
      on: true,
      dropped: false,
      leaving: true,
      off: leaveOff,
      at: { x: leaveFrom.x - 20, y: leaveFrom.y - 10 },
    },
  })
  await a.wait(80)
  await a.drag(
    { x: -110, y: leaveFrom.y },
    (at) => {
      a.put({ ghost: { on: true, dropped: false, leaving: true, off: leaveOff, at } })
    },
    { duration: 700, cursor: 'preserve' },
  )
  await a.set({ ghost: ghostOff })
  await a.wait(400)
  await a.snap({
    scan: '',
    mapped: 0,
    unmapped: false,
    renderCmd: '',
    progress: 0,
    done: false,
  })
  await a.wait(200)
}

export default function SamplesDemo() {
  return (
    <Stage<S>
      width={720}
      height={400}
      compact={{ below: 560, width: 358, height: 400 }}
      theme="dark"
      tokens={HB_LOOK}
      accent="#f2b544"
      initial={initial}
      poster={poster}
      script={script}
      play="loop"
      cursor={{ at: { at: 'drop', x: 0.42, y: 0.28 }, style: 'arrow', ripple: true }}
      className="sd"
    >
      {(s, _rect, layout) => {
        // Corner bleed (dark-hero): equal top+left gutter; folder chip straddles the
        // window's left edge (upload satellite). Window sits fully inside the stage (s463: Ray read the old bleed as cut off).
        const desk = layout === 'wide' ? { x: 4, y: 132 } : { x: 4, y: 100 }
        const win =
          layout === 'wide'
            ? { x: 28, y: 28, w: 664, h: 344 }
            : { x: 16, y: 12, w: 326, h: 376 }
        const lifted = s.ghost.on && !s.ghost.dropped && !s.ghost.leaving
        const showDesk = !s.ghost.dropped && !s.ghost.leaving
        return (
          <>
            {showDesk ? (
              <div
                className="sd-desk"
                data-target="desk-file"
                data-lifted={lifted || undefined}
                style={{ left: desk.x, top: desk.y }}
              >
                <span data-target="desk-icon">
                  <FolderChip />
                </span>
                <span className="sd-desk__name">MyDrums/</span>
              </div>
            ) : null}

            <Window
              className="sd-win"
              style={{ left: win.x, top: win.y, width: win.w, height: win.h }}
              chrome="terminal"
              lights="grey"
              title="house-band"
              body={{ className: 'sd-body', 'data-crop': true, 'data-target': 'drop', 'data-drop': true }}
            >
              <div className="sd-term" data-layout={layout}>
                <TermLine text={s.scan} active={s.scan.length > 0 && s.mapped === 0 && !s.renderCmd} />

                <div className="sd-grid" data-target="grid">
                  {MAPPED.map((line, i) => (
                    <RoleCell key={line} line={line} kind="mapped" on={i < s.mapped} />
                  ))}
                  {UNMAPPED.map((line) => (
                    <RoleCell key={line} line={line} kind="unmapped" on={s.unmapped} />
                  ))}
                </div>

                <div className="sd-render" data-on={s.renderCmd || s.progress > 0 || s.done ? true : undefined}>
                  <TermLine
                    text={s.renderCmd}
                    active={s.renderCmd.length > 0 && s.progress < 1 && !s.done}
                  />
                  <Meter className="sd-bar" value={s.progress} tone="accent" />
                </div>

                <div className="sd-payoff" data-target="wave" data-on={s.done || undefined}>
                  <Waveform />
                  <span className="sd-wav">song.wav</span>
                </div>
              </div>
            </Window>

            <DragImage ghost={s.ghost}>
              <FolderChip />
              <span className="sd-drag__name">MyDrums/</span>
            </DragImage>
          </>
        )
      }}
    </Stage>
  )
}

function TermLine({ text, active }: { text: string; active: boolean }) {
  return (
    <div className="sd-line">
      <span className="sd-dollar">$</span>
      <span className="sd-cmd">{text}</span>
      {active ? <Caret still /> : null}
    </div>
  )
}

function RoleCell({ line, kind, on }: { line: string; kind: 'mapped' | 'unmapped'; on: boolean }) {
  return (
    <div className="sd-cell" data-kind={kind} data-on={on || undefined}>
      {line}
    </div>
  )
}

function FolderChip() {
  return (
    <span className="sd-folder">
      <Folder size={22} strokeWidth={1.6} />
    </span>
  )
}

function Waveform() {
  const bars = [4, 10, 16, 22, 18, 26, 14, 20, 28, 12, 22, 30, 18, 24, 10, 16, 22, 14, 8, 12]
  return (
    <div className="sd-wave" aria-hidden>
      {bars.map((h, i) => (
        <i key={i} style={{ height: h }} />
      ))}
    </div>
  )
}

/** Drag image follows the cursor (from examples/upload); lights [data-drop] under it. */
function DragImage({ ghost, children }: { ghost: Ghost; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const over = useRef<HTMLElement | null>(null)
  const following = ghost.on && (!ghost.dropped || ghost.leaving)
  const { x: ox, y: oy } = ghost.off
  const { x, y } = ghost.at
  useLayoutEffect(() => {
    const root = ref.current?.closest<HTMLElement>('.ss-stage')
    let next: HTMLElement | null = null
    if (following && !ghost.leaving && root) {
      const box = root.getBoundingClientRect()
      const scale = box.width / root.offsetWidth || 1
      const hit =
        document.elementFromPoint(box.left + x * scale, box.top + y * scale)?.closest<HTMLElement>('[data-drop]') ??
        null
      if (hit && root.contains(hit)) next = hit
    }
    if (next !== over.current) {
      over.current?.removeAttribute('data-over')
      next?.setAttribute('data-over', '')
      over.current = next
    }
  }, [following, ghost.leaving, x, y])
  useLayoutEffect(() => () => over.current?.removeAttribute('data-over'), [])
  return (
    <div
      ref={ref}
      className="sd-drag"
      data-show={following || undefined}
      data-dropped={ghost.dropped && !ghost.leaving ? true : undefined}
      data-leaving={ghost.leaving || undefined}
      style={{ transform: `translate(${x - ox}px, ${y - oy}px)` }}
      aria-hidden
    >
      <div className="sd-drag__inner" style={{ transformOrigin: `${ox}px ${oy}px` }}>
        {children}
      </div>
    </div>
  )
}
