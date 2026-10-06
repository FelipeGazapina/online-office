# Task boards, task time and handing a task to a desk

## Decision

Tasks are the office's own records. A block owns boards, a board holds tasks, a task sits in one of four stages, and the owner hands a task to a person by dragging its card onto that person's desk. Provider cards (Linear, CronoSpark) are an input to a board, not the thing the board shows. Time is never stored. It is read back from the mail ledger.

## Shape

- **Boards.** Every block has a quick board for tasks from the owner's head, and may have feature or bug boards that pull cards from sources (`Board`, `ensureBoards`). A quick board takes no sources and logs no hours. The HUD board and the compact 3D wall board read the same snapshot.
- **Tasks and stages.** A `Task` is `todo`, `doing`, `review` or `done`. A provider status sets the stage through `stageOfStatus` only while the office has no say: once a task has a run, or the owner moved it (`stagePinned`), sync leaves the stage alone. A settled run moves a `doing` task to review, or back to todo when it failed (`outcomeFromRuns`).
- **Assigning.** `assign_task` gives a person one work request. The request's root id goes into `task.runs`, which is how mail, time and outcome find the task. A task can have several people and several runs.
- **Time.** `foldTurn` rebuilds who was in a turn from the ledger, and `sliceTasks` cuts each turn at every delivery. A turn serving several tasks gives each an equal share, so no minute is counted twice. A task's time is the sum over people, and hours go to CronoSpark per person and local day (`hoursDue`, the marks in `HoursLog`).

## Handing a task to a desk

A card pulled out of the columns folds the board away. The desk under the pointer lights up with what letting go does, and the card hangs off the pointer.

- **Which desk and what happens.** `deskUnder` finds the desk the camera ray hits, and `verdictFor` turns it into assign, hire or refuse (`deskDrop.ts`, pure). One verdict drives the highlight, the words and the drop. A desk of another block, and a hire past the headcount cap, are refused with the reason.
- **Where the card hangs.** `hangCard` (`carry.ts`, pure) puts the card and its line in the nearest spot that covers no name tag, no bubble, no desk label and not the bar, and keeps it there while that spot stays free. `hang.ts` reads the tags from the page each frame. The bar at the bottom says what letting go does for the target (`barOf`): give it to Ana, hire for this desk, move to a stage, or why it is refused.
- **After a drop on a person.** The board stays folded as a tray of the cards still in Todo (`modal.tray`), so the next card is one drag away. The tray has an Open board button, the Tasks chip opens the board from anywhere, and Esc or the close button dismisses it. It closes by itself when Todo is empty.

## Why this shape

- A local board beats an embedded Linear page. An iframe cannot hand a card to an in-world employee without a second lookup, and it depends on the page's own login.
- Time as a fold means a restart, a crash or a second run can never leave a stored total wrong. Each person's entries match their busy wall time.
- Lifting the tags above the card was considered and dropped. The tags live inside the canvas stack and the card above all of the HUD, so it would mean moving the tags into the HUD layer, and a card sitting on a tag still hides what is around it. Moving the card keeps it off every tag.
- The tray is the folded board, not a second panel, so the first-person cursor release, Esc and key isolation of a dialog come for free. The cost is that WASD and camera keys stay off while it is up. Esc brings them back.

## Known limits

- A drop on an empty desk opens the hire panel, and cancelling it goes back to the whole board, not the tray.
- The tray lists Todo only. A card in another stage is handed out from the board.
