/** Pure view inputs for the desktop onboarding flow. */
import type { OnboardingProgress } from '../onboarding-settings.ts'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { PlatformBridge } from './PlatformOverlay.tsx'
import type { AccountKey } from './locales.ts'

/** Render state with pending choices previewed over durable Host progress. */
export interface DesktopOnboardingState {
  status: 'loading' | 'ready' | 'saving' | 'error'
  visible: boolean
  progress: OnboardingProgress
  /** Whether positive balance was already available at first credit-page entry; pending uses ordinary actions, never persisted. */
  creditFunded: boolean
  error: 'settings' | null
}

/** User-selected fields accepted before final preference application. */
export type OnboardingChange = Partial<Pick<OnboardingProgress, 'step' | 'purpose' | 'process'>>

/** Data and callbacks consumed by the presentational desktop flow. */
export interface DesktopOnboardingProps {
  /** Keep the saved final step visible while revealing the workspace. */
  exiting?: boolean
  state: DesktopOnboardingState
  account: AccountSnapshot
  platform?: PlatformBridge
  refresh(this: void): Promise<void>
  update(this: void, change: OnboardingChange): Promise<boolean>
  complete(this: void, reason: 'completed' | 'skipped'): Promise<boolean>
  retry(this: void): Promise<boolean>
  /** Active interface language selects the matching illustration artwork. */
  locale: string
  t: (key: AccountKey) => string
}
