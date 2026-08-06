// Web e2e scenario: at the 800×720 viewport the plan chip and the model
// trigger keep disjoint click areas, the plan chip's center hit-tests to the
// chip itself, and clicking it leaves plan mode through the real command
// channel. This is the browser regression the external report asked for
// (dsh-external/issues#107 → deepseek-harness#1406): "increase an 800×720
// browser regression test and assert that the plan center hits the plan
// button".
//
// Plan mode is entered through the real /plan command once, during record,
// against the live model; replay replays the recorded turn keyless. Plan
// state folds from the session log (`plan/mode`, last one wins), so the chip
// is present at replay time without any model call. A cold seeded session
// cannot serve the exit path: the chip executes /plan off through
// commands.execute, which needs the live agent the recorded turn keeps — the
// product's own user path for this scenario.
//
// The geometry is measured, not asserted on absolute coordinates: chip and
// trigger widths depend on the installed fonts, so the golden records
// viewport membership, the hit-test verdict, the gap between the two click
// areas, and the exit result — stable facts a font change cannot move.
// jsdom resolves no layout, so only a real engine can answer any of them.
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the plan/mode SessionEventMap merge so the discriminant
// comparison below types as the plan-mode event, matching the recorded log.
import type {} from '@deepseek-ai/dsh-plan-mode'
import {
  assertFixtureInventory, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/plan-narrow-viewport', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const LAYOUT_EXPECTED = join(SNAPSHOT_DIR, 'layout.expected.md')
const MODE = webSnapshotMode()

/** The reported viewport: 800×720, where the composer card is 448px wide at 0.0.1. */
const VIEWPORT = { width: 800, height: 720 } as const

/** Chip aria-label on the English page; the seat renders only while plan is the effective target. */
const CHIP_ARIA = 'Plan mode on, press to turn off'

/**
 * The recorded user prompt. The model must not call exit_plan_mode: that
 * would raise the review takeover and replace the composer's control row,
 * which is the surface under test. The guidance section still asks it to
 * produce a plan, so the prompt overrides that for the recorded turn.
 */
const TASK = 'Reply with exactly the single word OK and call no tools. Do not produce a plan. This is a layout test, not a planning session.'
const LINE = `/plan ${TASK}`

/** The model trigger's accessible name: "Select model" or the current model variant. */
const MODEL_TRIGGER = (page: Page) => (
  page.getByRole('button', { name: /Select model/ })
)

interface RowGeometry {
  chipInViewport: boolean
  triggerInViewport: boolean
  /** Horizontal gap between the chip's right edge and the trigger's left edge; negative means overlap. */
  gap: number
  /** Overlap rectangle in px²; 0 means disjoint. */
  overlapArea: number
  /** Debug-only chip box for diagnosing a failed layout assertion. */
  chipBox: { x: number; y: number; width: number; height: number }
  /** Debug-only trigger box for diagnosing a failed layout assertion. */
  triggerBox: { x: number; y: number; width: number; height: number }
}

function overlapBox(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): { width: number; height: number } {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/**
 * Measure the composer control row at the recorded viewport. The center
 * hit-test is not measured here: the test clicks the chip at its center
 * through Playwright's actionability check, which fails in a real engine when
 * the point does not receive pointer events — the reported acceptance as a
 * behavior instead of a coordinate probe.
 * @param page - the browser page at 800×720.
 * @returns the measured geometry.
 */
async function measureRow(page: Page): Promise<RowGeometry> {
  const chip = page.getByRole('button', { name: CHIP_ARIA })
  const trigger = MODEL_TRIGGER(page)
  await chip.waitFor({ timeout: 10_000 })
  await trigger.waitFor({ timeout: 10_000 })
  const chipBox = await chip.boundingBox()
  const triggerBox = await trigger.boundingBox()
  expect(chipBox).not.toBeNull()
  expect(triggerBox).not.toBeNull()
  const overlap = overlapBox(chipBox!, triggerBox!)
  return {
    chipInViewport: chipBox!.x >= 0 && chipBox!.x + chipBox!.width <= VIEWPORT.width,
    triggerInViewport: triggerBox!.x >= 0 && triggerBox!.x + triggerBox!.width <= VIEWPORT.width,
    gap: triggerBox!.x - (chipBox!.x + chipBox!.width),
    overlapArea: overlap.width * overlap.height,
    chipBox: chipBox!,
    triggerBox: triggerBox!,
  }
}

/** Render the golden body from the measured row geometry. */
function renderLayout(geometry: RowGeometry): string {
  return [
    '# Plan chip and model trigger at the 800×720 viewport',
    '',
    `- Plan chip fully in viewport: ${String(geometry.chipInViewport)}`,
    `- Model trigger fully in viewport: ${String(geometry.triggerInViewport)}`,
    `- Gap between chip right edge and trigger left edge: ${String(geometry.gap)}px (negative would overlap)`,
    `- Overlap area: ${String(geometry.overlapArea)}px²`,
  ].join('\n').trimEnd()
}

describe('web e2e: plan chip click area at the narrow viewport', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser, VIEWPORT.height)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.setViewportSize(VIEWPORT)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps the plan chip and model trigger disjoint and exits plan mode by click', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plan-narrow-viewport'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([TASK])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 180_000 : 30_000)
    await input.fill(LINE)
    await input.press('Enter')

    // Plan mode is on once the recorded turn settles: the fold of plan/mode
    // events is active and the review takeover never appeared (the model
    // called no tool), so the composer control row — the surface under test —
    // is the one visible.
    const chip = page.getByRole('button', { name: CHIP_ARIA })
    await chip.waitFor({ timeout: MODE === 'record' ? 120_000 : 30_000 })
    const sessionId = await settled
    const geometry = await measureRow(page)
    if (MODE !== 'record') {
      await compareOrRefreshGolden(LAYOUT_EXPECTED, renderLayout(geometry), MODE)
    }

    // The reported acceptance, asserted as behavior: the click areas are
    // disjoint, both controls stay in viewport, and — below — the click at
    // the chip's center leaves plan mode. Playwright's actionability check
    // makes the center click fail in the real engine if the point is covered
    // by the model trigger, which is the reported bug as a failing click.

    expect(geometry.overlapArea).toBe(0)
    expect(geometry.chipInViewport).toBe(true)
    expect(geometry.triggerInViewport).toBe(true)

    if (MODE === 'record') {
      mkdirSync(SNAPSHOT_DIR, { recursive: true })
      await recordFixture(scaffold, sessionId, FIXTURE)
      return
    }
    // Exit through the real command channel: the click executes /plan off and
    // the folded projection flips inactive, so the chip unmounts.
    await chip.click({ position: { x: geometry.chipBox.width / 2, y: geometry.chipBox.height / 2 } })
    await expect.poll(() => page.getByRole('button', { name: CHIP_ARIA }).count(), { timeout: 15_000 }).toBe(0)
    // The click must have committed the exit: the session log carries a
    // plan/mode event that flips inactive. The serialized check avoids the
    // plan-mode discriminant entirely — the lint type service has no plan-mode
    // declaration in this client-graph-excluded file — while still proving the
    // log fact.
    const serializedLog = String(JSON.stringify(sessionEvents))
    expect(serializedLog).toContain('"type":"plan/mode"')
    expect(serializedLog).toContain('"active":false')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 200_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'layout.expected.md'])
  })
})
