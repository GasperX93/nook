# Nook docs

This folder holds the living specification for Nook — how the app actually works, in enough detail that a new contributor (or future-you in six months) can understand what's going on without reading every file.

## How to read these

Topics are split by domain, not by file/folder layout in the codebase. Start with **architecture** for a high-level pass; jump to topic-specific docs when you need depth.

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | Backend + frontend layers, startup sequence, runtime data paths, IPC boundaries |
| [stamps.md](stamps.md) | Postage stamp lifecycle: buying, depth math, dilute, topup, displayed capacity |
| [identity.md](identity.md) | Nook address, derived keys, contact link, sharing key, identity feed |
| [encryption.md](encryption.md) | ACT history, encrypted drives, grantee management, metadata feed |
| [messaging.md](messaging.md) | Swarm Notify integration: mailbox, registry, contact-state machine |

## Decision records

`decisions/` holds short ADRs (Architecture Decision Records) — one page each capturing **why** a major call was made, not what it does. The "what" goes in topic docs; the "why" goes in ADRs.

| ADR | Decision |
|---|---|
| [001-variable-overbuy.md](decisions/001-variable-overbuy.md) | Variable-overbuy SIZE_PRESETS for honest stamp capacity display |

Write a new ADR when:
- A choice has lasting implications and the reasoning isn't obvious from the code
- Future contributors might want to revisit and need to know the constraints we faced
- The decision could otherwise be re-litigated later because nobody remembers why

ADRs are numbered sequentially and never deleted — superseded ones get a "**Status: superseded by NNN**" header but stay in the repo as history.

## Maintenance

These docs are part of the code. PRs that change behavior should update the relevant doc in the same commit. If you're editing a topic doc, also check whether an ADR needs to be written for the choice you made.

If a doc disagrees with the code, **the code wins** — but file an issue (or fix the doc) immediately. Docs drifting silently is how this system loses value.
