# schedule/ — Session-local reminders

English | [中文](README.zh.md)

The Schedule family owns reminders whose durable state lives in the original Session log. A process-local owner waits only while that Session has a live root Agent; cold Sessions resume overdue work when they become live again and never imply an external notification channel. An optional Session projection publishes the complete active-record set for read-only clients without changing that delivery boundary.

| Package | Role | ctx key |
|---|---|---|
| `schedule/` | Versioned Schedule events and fold, the active-record Session projection, model-facing create/list/delete tools, and a live root-Agent timer owner | — |

The package deliberately exposes no public Schedule service or mutable database. Tools and runtime append to the Session stream; due work enters the same conversation through the Agent's ordinary follow-up queue. The browser presentation is owned separately by [`dsh-client-ui-schedule`](../client/ui-schedule/README.md), whose catalog is current state rather than a delivery receipt.

See [Session-local Schedule](../../docs/subsystems/schedule.md) for the durable record, transition, view, and delivery contracts.
