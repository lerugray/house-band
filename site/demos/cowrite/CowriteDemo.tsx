import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { File } from 'lucide-react'
import { Stage } from '../../vendor/stageshow/kit/stage'
import type { Act } from '../../vendor/stageshow/kit/act'
import type { LookTokens } from '../../vendor/stageshow/kit/stage'
import { Window, Caret } from '../../vendor/stageshow/kit/window'
import type { Point } from '../../vendor/stageshow/kit/measure'
import './cowrite.css'

// Co-write: Appendix N maybean2.notes.xrns lands, yours lanes light in --yours
// blue from the real XRNS instrument names, amber House Band parts grow under
// them, section strip A B C A' D fills, play head runs. Gold look: examples/dark-hero.
// Motion: examples/choreography (retained tracks, dependent timing) + upload drop.
// Strings: PLAN.md (c)/(e) and WHAT-TO-LISTEN-FOR.md (Maybe AN 2).

const IMPORT = 'house-band cowrite import maybean2.notes.xrns'
const DEVELOP = 'house-band cowrite develop maybean2.source.json --form subtractive'
const FILE_CHIP = 'maybean2.notes.xrns'
const CAPTION = 'yours, four passes, with drop-outs'

/** Instrument names from ray-maybean2.data.mjs / OSS-18 import of maybean2 (four lanes). */
const YOURS = [
  'AU: Prophet V3 (Init)',
  'AU: Mini V3 (Init)',
  'AU: Buchla Easel V (Init)',
  'BD 626 Color 01',
] as const

const ADDED = ['bass', 'pad', 'counter-line', 'drums'] as const

const SECTIONS = ['A', 'B', 'C', "A'", 'D'] as const

type Note = { left: number; width: number; row: number }

// First 8 bars (lines 0-127), scaled from ray-maybean2.data.mjs note events.
const NOTES: Record<(typeof YOURS)[number], Note[]> = {
  'AU: Prophet V3 (Init)': [
    { left: 0, width: 12.5, row: 0 },
    { left: 12.5, width: 12.5, row: 0 },
    { left: 25, width: 12.5, row: 0 },
    { left: 37.5, width: 7.8, row: 0 },
    { left: 50, width: 12.5, row: 0 },
    { left: 62.5, width: 12.5, row: 0 },
    { left: 75, width: 12.5, row: 0 },
    { left: 87.5, width: 7.8, row: 0 },
    { left: 25, width: 12.5, row: 1 },
    { left: 37.5, width: 9.4, row: 1 },
    { left: 75, width: 12.5, row: 1 },
    { left: 87.5, width: 9.4, row: 1 },
  ],
  'AU: Mini V3 (Init)': [
    { left: 0, width: 1.6, row: 0 },
    { left: 6.25, width: 1.6, row: 0 },
    { left: 12.5, width: 1.6, row: 0 },
    { left: 18.75, width: 1.6, row: 0 },
    { left: 25, width: 1.6, row: 0 },
    { left: 31.25, width: 1.6, row: 0 },
    { left: 37.5, width: 1.6, row: 0 },
    { left: 43.75, width: 1.6, row: 0 },
    { left: 50, width: 1.6, row: 0 },
    { left: 56.25, width: 1.6, row: 0 },
    { left: 62.5, width: 1.6, row: 0 },
    { left: 68.75, width: 1.6, row: 0 },
    { left: 75, width: 1.6, row: 0 },
    { left: 81.25, width: 1.6, row: 0 },
    { left: 87.5, width: 1.6, row: 0 },
    { left: 93.75, width: 1.6, row: 0 },
    { left: 3.13, width: 1.6, row: 1 },
    { left: 15.63, width: 1.6, row: 1 },
    { left: 28.13, width: 1.6, row: 1 },
    { left: 40.63, width: 1.6, row: 1 },
    { left: 53.13, width: 1.6, row: 1 },
    { left: 65.63, width: 1.6, row: 1 },
    { left: 78.13, width: 1.6, row: 1 },
    { left: 90.63, width: 1.6, row: 1 },
  ],
  'AU: Buchla Easel V (Init)': [
    { left: 0, width: 50, row: 0 },
    { left: 50, width: 50, row: 0 },
  ],
  'BD 626 Color 01': [
    { left: 0, width: 3.1, row: 0 },
    { left: 6.25, width: 3.1, row: 0 },
    { left: 12.5, width: 3.1, row: 0 },
    { left: 18.75, width: 3.1, row: 0 },
    { left: 25, width: 3.1, row: 0 },
    { left: 31.25, width: 3.1, row: 0 },
    { left: 37.5, width: 3.1, row: 0 },
    { left: 43.75, width: 3.1, row: 0 },
    { left: 50, width: 3.1, row: 0 },
    { left: 56.25, width: 3.1, row: 0 },
    { left: 62.5, width: 3.1, row: 0 },
    { left: 68.75, width: 3.1, row: 0 },
    { left: 75, width: 3.1, row: 0 },
    { left: 81.25, width: 3.1, row: 0 },
    { left: 87.5, width: 3.1, row: 0 },
    { left: 93.75, width: 3.1, row: 0 },
  ],
}

type Ghost = { on: boolean; dropped: boolean; leaving: boolean; off: Point; at: Point }

type S = {
  ghost: Ghost
  importCmd: string
  yours: number
  developCmd: string
  added: number
  sections: number
  playhead: number
  caption: boolean
  fading: number
}

const ghostOff: Ghost = { on: false, dropped: false, leaving: false, off: { x: 0, y: 0 }, at: { x: 0, y: 0 } }

const initial: S = {
  ghost: ghostOff,
  importCmd: '',
  yours: 0,
  developCmd: '',
  added: 0,
  sections: 0,
  playhead: -1,
  caption: false,
  fading: 0,
}

const poster: S = {
  ghost: { ...ghostOff, dropped: true },
  importCmd: IMPORT,
  yours: YOURS.length,
  developCmd: DEVELOP,
  added: ADDED.length,
  sections: SECTIONS.length,
  playhead: 0.72,
  caption: true,
  fading: 0,
}

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
  await a.wait(260)

  // Beat 1 (0-2 s): file chip drops; import types.
  a.mark('drop')
  const icon = a.rect('desk-icon')
  const file = a.rect('desk-file')
  const grab = { x: icon.x + icon.width / 2, y: icon.y + icon.height * 0.55 }
  await a.move(grab, { duration: 400 })
  await a.wait(100)
  const off = { x: grab.x - file.x, y: grab.y - file.y }
  const drop = a.rect('drop')
  await a.drag(
    { x: drop.x + drop.width * 0.4, y: drop.y + drop.height * 0.22 },
    (at) => {
      a.put({ ghost: { on: true, dropped: false, leaving: false, off, at } })
    },
    { duration: 860, cursor: 'preserve' },
  )
  a.mark('import')
  await a.set((s) => ({ ghost: { ...s.ghost, dropped: true, on: true } }))
  await a.wait(160)
  await a.type('importCmd', IMPORT, { interval: 18 })
  await a.wait(180)

  // Beat 2 (2-5 s): four yours lanes appear (dependent stagger).
  a.mark('yours')
  for (let i = 1; i <= YOURS.length; i++) {
    a.put({ yours: i })
    await a.wait(700)
  }

  // Beat 3 (5-9 s): develop types; amber lanes grow under; strip fills left to right
  // with dependent stagger (section cell leads each amber lane).
  a.mark('develop')
  await a.type('developCmd', DEVELOP, { interval: 12 })
  await a.wait(160)
  for (let i = 1; i <= ADDED.length; i++) {
    a.put({ sections: Math.min(SECTIONS.length, i) })
    await a.wait(160)
    a.put({ added: i })
    await a.wait(620)
  }
  a.put({ sections: SECTIONS.length })
  await a.wait(180)

  // Beat 4 (9-12 s): play head; A caption; hold as poster.
  a.mark('play')
  a.put({ caption: true, playhead: 0 })
  for (const p of [0.18, 0.36, 0.54, 0.72, 0.88]) {
    a.put({ playhead: p })
    await a.wait(420)
  }
  a.mark('payoff')
  a.put({ playhead: 0.72 })
  await a.wait(1400)

  // Loop reset: lanes fade in reverse order of arrival.
  a.mark('leave')
  a.put({ caption: false, playhead: -1 })
  for (let n = ADDED.length + YOURS.length; n >= 1; n--) {
    a.put({ fading: n })
    await a.wait(140)
  }
  await a.snap({
    importCmd: '',
    yours: 0,
    developCmd: '',
    added: 0,
    sections: 0,
    playhead: -1,
    caption: false,
    fading: 0,
    ghost: ghostOff,
  })
  await a.wait(220)
}

export default function CowriteDemo() {
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
      cursor={{ at: { at: 'drop', x: 0.4, y: 0.22 }, style: 'arrow', ripple: true }}
      className="cd"
    >
      {(s, _rect, layout) => {
        const desk = layout === 'wide' ? { x: 4, y: 132 } : { x: 4, y: 100 }
        const win =
          layout === 'wide'
            ? { x: 28, y: 28, w: 760, h: 420 }
            : { x: 16, y: 16, w: 400, h: 420 }
        const lifted = s.ghost.on && !s.ghost.dropped && !s.ghost.leaving
        const showDesk = !s.ghost.dropped && !s.ghost.leaving
        return (
          <>
            {showDesk ? (
              <div
                className="cd-desk"
                data-target="desk-file"
                data-lifted={lifted || undefined}
                style={{ left: desk.x, top: desk.y }}
              >
                <span data-target="desk-icon">
                  <FileChip />
                </span>
                <span className="cd-desk__name">{FILE_CHIP}</span>
              </div>
            ) : null}

            <Window
              className="cd-win"
              style={{ left: win.x, top: win.y, width: win.w, height: win.h }}
              chrome="terminal"
              lights="grey"
              title="house-band cowrite"
              body={{ className: 'cd-body', 'data-crop': true, 'data-target': 'drop', 'data-drop': true }}
            >
              <div className="cd-term" data-layout={layout}>
                <TermLine
                  text={s.importCmd}
                  active={s.importCmd.length > 0 && s.yours === 0 && !s.developCmd}
                />

                <div className="cd-lanes" data-target="lanes">
                  {YOURS.map((name, i) => {
                    const on = i < s.yours
                    const fadeRank = ADDED.length + (YOURS.length - i)
                    const fading = s.fading > 0 && s.fading <= fadeRank
                    return (
                      <Lane
                        key={name}
                        name={name}
                        kind="yours"
                        on={on && !fading}
                        notes={NOTES[name]}
                      />
                    )
                  })}
                  {ADDED.map((name, i) => {
                    const on = i < s.added
                    const fadeRank = ADDED.length - i
                    const fading = s.fading > 0 && s.fading <= fadeRank
                    return <Lane key={name} name={name} kind="added" on={on && !fading} />
                  })}
                </div>

                <div className="cd-develop" data-on={s.developCmd || s.added > 0 ? true : undefined}>
                  <TermLine
                    text={s.developCmd}
                    active={s.developCmd.length > 0 && s.added < ADDED.length}
                  />
                </div>

                <div className="cd-strip" data-target="strip" data-on={s.sections > 0 || undefined}>
                  {SECTIONS.map((label, i) => (
                    <div
                      key={label}
                      className="cd-cell"
                      data-on={i < s.sections || undefined}
                      data-a={label === 'A' || undefined}
                    >
                      <span className="cd-cell__label">{label}</span>
                      {label === 'A' ? (
                        <span className="cd-caption" data-on={s.caption || undefined}>
                          {CAPTION}
                        </span>
                      ) : (
                        <span className="cd-caption cd-caption--spacer" aria-hidden>
                          {CAPTION}
                        </span>
                      )}
                    </div>
                  ))}
                  {s.playhead >= 0 ? (
                    <div
                      className="cd-playhead"
                      data-target="playhead"
                      style={{ left: `${s.playhead * 100}%` }}
                    />
                  ) : null}
                </div>
              </div>
            </Window>

            <DragImage ghost={s.ghost}>
              <FileChip />
              <span className="cd-drag__name">{FILE_CHIP}</span>
            </DragImage>
          </>
        )
      }}
    </Stage>
  )
}

function TermLine({ text, active }: { text: string; active: boolean }) {
  return (
    <div className="cd-line">
      <span className="cd-dollar">$</span>
      <span className="cd-cmd">{text}</span>
      {active ? <Caret still /> : null}
    </div>
  )
}

function Lane({
  name,
  kind,
  on,
  notes,
}: {
  name: string
  kind: 'yours' | 'added'
  on: boolean
  notes?: Note[]
}) {
  return (
    <div className="cd-lane" data-kind={kind} data-on={on || undefined}>
      <span className="cd-lane__name" title={name}>
        {name}
      </span>
      <div className="cd-lane__roll" aria-hidden>
        {notes
          ? notes.map((n, i) => (
              <i
                key={i}
                style={{
                  left: `${n.left}%`,
                  width: `${n.width}%`,
                  top: `${18 + n.row * 28}%`,
                }}
              />
            ))
          : kind === 'added'
            ? ADDED_BLOCKS[name as (typeof ADDED)[number]].map((n, i) => (
                <i
                  key={i}
                  style={{
                    left: `${n.left}%`,
                    width: `${n.width}%`,
                    top: `${22 + n.row * 30}%`,
                  }}
                />
              ))
            : null}
      </div>
    </div>
  )
}

/** Amber arrangement blocks (illustrative density under yours; not scored notes). */
const ADDED_BLOCKS: Record<(typeof ADDED)[number], Note[]> = {
  bass: [
    { left: 0, width: 8, row: 0 },
    { left: 12, width: 8, row: 0 },
    { left: 25, width: 8, row: 0 },
    { left: 37, width: 8, row: 0 },
    { left: 50, width: 8, row: 0 },
    { left: 62, width: 8, row: 0 },
    { left: 75, width: 8, row: 0 },
    { left: 87, width: 8, row: 0 },
  ],
  pad: [
    { left: 0, width: 24, row: 0 },
    { left: 28, width: 24, row: 0 },
    { left: 56, width: 24, row: 0 },
    { left: 84, width: 14, row: 0 },
  ],
  'counter-line': [
    { left: 8, width: 6, row: 0 },
    { left: 22, width: 6, row: 0 },
    { left: 40, width: 10, row: 0 },
    { left: 58, width: 6, row: 0 },
    { left: 72, width: 10, row: 0 },
    { left: 90, width: 6, row: 0 },
  ],
  drums: [
    { left: 0, width: 2.5, row: 0 },
    { left: 12.5, width: 2.5, row: 0 },
    { left: 25, width: 2.5, row: 0 },
    { left: 37.5, width: 2.5, row: 0 },
    { left: 50, width: 2.5, row: 0 },
    { left: 62.5, width: 2.5, row: 0 },
    { left: 75, width: 2.5, row: 0 },
    { left: 87.5, width: 2.5, row: 0 },
    { left: 6.25, width: 2, row: 1 },
    { left: 18.75, width: 2, row: 1 },
    { left: 31.25, width: 2, row: 1 },
    { left: 43.75, width: 2, row: 1 },
    { left: 56.25, width: 2, row: 1 },
    { left: 68.75, width: 2, row: 1 },
    { left: 81.25, width: 2, row: 1 },
    { left: 93.75, width: 2, row: 1 },
  ],
}

function FileChip() {
  return (
    <span className="cd-file">
      <File size={22} strokeWidth={1.6} />
    </span>
  )
}

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
      className="cd-drag"
      data-show={following || undefined}
      data-dropped={ghost.dropped && !ghost.leaving ? true : undefined}
      data-leaving={ghost.leaving || undefined}
      style={{ transform: `translate(${x - ox}px, ${y - oy}px)` }}
      aria-hidden
    >
      <div className="cd-drag__inner" style={{ transformOrigin: `${ox}px ${oy}px` }}>
        {children}
      </div>
    </div>
  )
}
