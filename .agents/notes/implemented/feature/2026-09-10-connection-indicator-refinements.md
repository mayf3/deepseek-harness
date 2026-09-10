# Agent Note: Connection indicator state and interaction refinements

Status: implemented

English | [中文](2026-09-10-connection-indicator-refinements.zh.md)

## Problem

The sidebar connection pill hid its affordance behind a hover swap: outage and retry-attempt states replaced their label with **Reconnect now** on hover or focus, so every state had to reserve the widest supplied label to keep the control from resizing. A retry that resolved in under a second flickered the connecting pill in and out, a manual click read identically to automatic backoff, and state changes and unmounts jumped with no transition.

## Decision

**The disconnected pill names its action statically.** [ConnectionIndicator.tsx](../../../../packages/client/ui-primitives/src/ConnectionIndicator.tsx) renders a retry glyph (`IconRefreshOutline14`) beside outage copy that itself names the retry action (`连接异常，刷新重试` / `Disconnected`); clicking the pill still reconnects immediately. The hover label swap and the hidden widest-label size-reservation spans are gone, so the pill sizes to its current label. The connecting state shows a rotating-arc spinner instead of the exclamation glyph. Appearance, state changes, and removal fade over 150ms: `EXIT_MS` delays unmount to match the stylesheet's `.leaving` transition, and `prefers-reduced-motion` disables every animation and transition. Chrome settles at 28px height, 8px horizontal padding, 4px icon gap, 13px radius, and a 1px border of the label color at 20% alpha.

**The shell owns attempt pacing and attempt naming.** [SettingsRoot.tsx](../../../../packages/client/ui-settings-general/src/client/SettingsRoot.tsx) keeps the connecting pill visible for at least `CONNECTING_MIN_VISIBLE_MS` (800ms) so sub-second retries do not flicker, and tracks a `manualRetry` flag set by the pill click so a user-initiated attempt reads `重新连接中` (`connection.reconnecting`) while automatic backoff reads `自动重连中` (`connection.connecting`). Both timings are built-in presentation constants of their owners, like the recovery confirmation's existing two seconds, not configuration.

## Alternatives considered

**Animating width changes.** A FLIP-style measured pixel transition (remember the old width, pin it, transition to the new measurement) was implemented and then removed: the fade-only change reads calm enough, and the measurement replay added a layout effect and imperative style writes for marginal polish.

**Swapping to the retry glyph on hover.** An 80ms cross-fade from the warning glyph to the retry glyph on hover was implemented and then simplified away: showing the retry glyph permanently states the affordance without requiring any pointer interaction, matching the static label decision.

**Scaling on enter/exit.** A 0.98 scale accompanied the fades first; at 12px text the movement read as jitter, so only opacity remains.

## Consequences

`ConnectionIndicator`'s `reconnectLabel` prop and its size-reservation spans are removed from the pre-stable API; the sole consumer (`ui-settings-general`) is updated in the same change. `settings-root.client.spec.tsx` pins the 800ms hold, the manual-versus-automatic naming, and the fade-out delay; `atoms.client.spec.tsx` pins the exit-duration unmount. Both packages' READMEs restate the interaction.
