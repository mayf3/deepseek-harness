# Agent Note: Offline-first defaults

Status: implemented

English | [中文](agent-note.zh.md)

## Problem

Online checks delayed every run.

## Decision

Run offline by default; expose one opt-in flag.

## Consequences

Runs start instantly. Telemetry stays off unless enabled.
