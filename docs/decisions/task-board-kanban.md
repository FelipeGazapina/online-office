# Task board Kanban projection

The task board keeps provider cards as the integration boundary and derives a presentation column from each card's status. A column is `{ id, label, cards }`; card identity stays the provider-qualified `TaskCard.id`, so selecting a card still sends the same assignment command to the main process.

Two shapes were considered. An embedded Linear page would reproduce the remote board, but it cannot hand a selected remote card to an in-world employee without a second lookup and is dependent on iframe authentication. A local Kanban projection uses the authenticated MCP result, preserves the same issue identifiers and links, and lets the existing `assign_task` command remain the single assignment boundary. The local projection is the chosen shape.

Status labels are normalized into the Linear-style columns `Open`, `In Design`, `In Dev`, `In Progress`, `Ready to Review`, `Done`, and `Deferred`. Unknown provider states remain visible as their own columns after the known order. The modal is the actionable surface opened by `F`; the 3D board is a compact preview of the same columns.

