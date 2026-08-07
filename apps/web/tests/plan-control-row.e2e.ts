// Web e2e scenario: at the 800×720 viewport the plan chip and the model
// trigger keep disjoint click areas, and clicking the chip at its center
// leaves plan mode through the real command channel. This is the browser
// regression the external report asked for (dsh-external/issues#107 →
// deepseek-harness#1406): "increase an 800×720 browser regression test and
// assert that the plan center hits the plan button".
//
// Plan mode is entered through the real /plan command once, during record,
// against the live model; replay replays the recorded turn keyless. Plan
// state folds from the session log (`plan/mode`, last one wins), so the chip
// is present at replay time without any model call. A cold seeded session
// cannot serve the exit path: the chip executes /plan off through
// commands.execute, which needs the live agent the recorded turn keeps — the
// product's own user path for this scenario.
//
// The geometry golden records stable facts — viewport membership on both
// axes for the chip and the trigger, and disjoint click areas — never
// absolute coordinates, whose pixel values depend on installed fonts and
// differ between macOS and Linux. The center hit-test is Playwright's
// actionability check: clicking the chip
// fails in a real engine when the element center does not receive pointer
// events. jsdom resolves no layout, so only a real engine can answer any of
// these facts.
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
// Type-only: pulls the plan/mode SessionEventMap merge so the discriminant
// filter below types as the plan-mode event in the host aggregate.
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
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
    const trigger = page.getByRole('button', { name: /Select model/ })
    await chip.waitFor({ timeout: MODE === 'record' ? 120_000 : 30_000 })
    await trigger.waitFor({ timeout: 10_000 })
    const sessionId = await settled
    const chipBox = await chip.boundingBox()
    const triggerBox = await trigger.boundingBox()
    expect(chipBox).not.toBeNull()
    expect(triggerBox).not.toBeNull()

    // The reported acceptance as numbers: both controls in viewport and
    // disjoint click areas (a non-zero overlap would fail), and — in the
    // click below — the chip center receiving the pointer.
    const chipInViewport = chipBox!.x >= 0 && chipBox!.x + chipBox!.width <= VIEWPORT.width
      && chipBox!.y >= 0 && chipBox!.y + chipBox!.height <= VIEWPORT.height
    const triggerInViewport = triggerBox!.x >= 0 && triggerBox!.x + triggerBox!.width <= VIEWPORT.width
      && triggerBox!.y >= 0 && triggerBox!.y + triggerBox!.height <= VIEWPORT.height
    const overlapLeft = Math.max(chipBox!.x, triggerBox!.x)
    const overlapTop = Math.max(chipBox!.y, triggerBox!.y)
    const overlapRight = Math.min(chipBox!.x + chipBox!.width, triggerBox!.x + triggerBox!.width)
    const overlapBottom = Math.min(chipBox!.y + chipBox!.height, triggerBox!.y + triggerBox!.height)
    const overlapArea = Math.max(0, overlapRight - overlapLeft) * Math.max(0, overlapBottom - overlapTop)

    if (MODE !== 'record') {
      const golden = [
        '# Plan chip and model trigger at the 800×720 viewport',
        '',
        '- Plan chip fully in viewport: ' + (chipInViewport ? 'true' : 'false'),
        '- Model trigger fully in viewport: ' + (triggerInViewport ? 'true' : 'false'),
        '- Click areas disjoint: ' + (overlapArea === 0 ? 'true' : 'false'),
      ].join('\n').trimEnd()
      await compareOrRefreshGolden(LAYOUT_EXPECTED, golden, MODE)
    }
    expect(overlapArea).toBe(0)
    expect(chipInViewport).toBe(true)
    expect(triggerInViewport).toBe(true)

    if (MODE === 'record') {
      mkdirSync(SNAPSHOT_DIR, { recursive: true })
      await recordFixture(scaffold, sessionId, FIXTURE)
      return
    }
    // Exit through the real command channel: the click at the chip's center
    // executes /plan off and the folded projection flips inactive, so the chip
    // unmounts. Playwright's click() targets the element center by default and
    // its actionability check fails the click when that point is covered by
    // the model trigger — the reported bug as a failing click rather than a
    // coordinate probe.
    await chip.click()
    await expect.poll(() => page.getByRole('button', { name: CHIP_ARIA }).count(), { timeout: 15_000 }).toBe(0)
    // The click must have committed the exit: the last plan/mode event flips
    // inactive (the recorded turn's entry event stays active:true earlier in
    // the log, so the pair proves the exit and not just the entry).
    const planModes = sessionEvents.filter(
      (event): event is SessionEvent<'plan/mode'> => event.type === 'plan/mode',
    )
    expect(planModes.at(-1)?.data.active).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 200_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'layout.expected.md'])
  })
})
