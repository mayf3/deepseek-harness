# Agent Note: Playwright video captures continuous browser demos

Status: implemented

English | [中文](2026-09-08-playwright-video-gif.zh.md)

## Problem

A screenshot storyboard omits motion between verified UI states and can miss short-lived progress indicators. Browser tooling also varies between agent environments. GIF production needs a repeatable recording path that preserves interactions and keeps text readable without adding a browser driver dependency.

## Decision

The [recording skill](../../../skills/record-browser-gif/SKILL.md) prefers the repository-declared Playwright dependency with `recordVideo` in an isolated context. Viewport and video dimensions match explicitly, avoiding Playwright's default scaling to fit 800×800. The recorder retains the page video, awaits context closure, and saves the completed WebM before encoding. Screenshot storyboards remain available when video recording is unavailable or explicitly unwanted.

One encoder accepts either a video file or a screenshot directory. Video input selects one continuous interval, applies a declared playback multiplier, and extends its final frame. The JSON summary records source duration, selected interval, speed, final hold, and encoded dimensions, duration, frame count, and size. Mode-inappropriate options and invalid intervals fail. The original video remains available for review; trimming and speed never establish model response latency.

This choice replaces only the browser-control-first preference in the [evidence-chain decision](2026-08-08-browser-gif-evidence-chain.md). That note continues to own isolated application state, real model execution, exact commit attribution, and verified publication. Failed recordings cannot contribute frames to a successful run.

## Alternatives considered

**Keep screenshots as the default.** Explicit state holds make small, legible GIFs, but omit scrolling, animation, and interactions between states. They remain useful as a fallback and for a requested storyboard.

**Install a separate recorder or capture the desktop.** The repository already declares Playwright. Another driver adds setup and version management; desktop capture can include unrelated windows and personal state.

## Consequences

Continuous recording preserves intermediate states, so reviewers must inspect the selected interval for sensitive content and readability. Raw video consumes additional scratch storage, and encoding may require trimming or scaling to meet the byte limit. Context closure is part of successful recording, not optional cleanup.

The encoder's local Python unittest suite invokes real ffmpeg and ffprobe to check timing, palette order, screenshot holds, rejected options, overwrite protection, and size limits. It requires the skill's media prerequisites and is run explicitly; repository CI does not provision these media binaries. Product demonstrations additionally exercise the pull request's built server and real model flow.
