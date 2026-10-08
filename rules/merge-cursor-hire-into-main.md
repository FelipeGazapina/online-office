# Merge Cursor hire into main

The Cursor SDK hire landed on `main` from `fix/missing-block-folder` (`0c5a7bb`). `origin/main` had already moved through mail, terminals, task boards, building, and Claude permission modes, so the merge kept that code and added only the Cursor login path.

## What stayed from main

- Block removal, mail, terminals, task handoff, and the building.
- Claude `stopTask`, `decisionReason`, and the live terminal.
- Office events use `error`, not `failed`.
- Hire from a dropped desk still sends `deskId` and `taskId`.

## What came in with Cursor

- Provider `cursor`, status `needs_login`, and client message `login_cursor`.
- `loginCursor` opens the system browser through `OfficeServices.openUrl`.
- The hire button says "Log in with Cursor" while the SDK is logged out, then Hire once the snapshot is ready.
- Esc on a Cursor employee cancels the run and reports `taskInterrupted`.
- Every harness record in the checks includes `cursor`.

## Checks after the resolution

From `app/`:

- `pnpm typecheck`
- `node verify/cursor-check.ts` (live SDK was logged out at 1.0.36)
- `node verify/office-check.ts`

Scratch notes under `.gauntlet/`, `.claude/`, and the `.codex-*-todo.md` files were left untracked.
