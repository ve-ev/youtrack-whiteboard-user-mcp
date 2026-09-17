# whiteboard-agent-mcp

MCP server that simulates one YouTrack whiteboard (Planning Canvas) user.
One running process is one user.

Each mutating tool does the REST call (persists) and then applies the same change to the
persona's own live Yjs document (other connected users see it in real time), exactly like a
browser tab. The persona also shows up in the "active users" list and has a live cursor.

## Setup

1. A running YouTrack instance, for example `http://localhost:8088`.
2. A permanent token per simulated user (Profile → Account Security → New Token).
3. A whiteboard id from its URL. Share the whiteboard with each simulated user.
4. `npm install`

## Run one persona

```bash
node src/index.js --baseUrl http://localhost:8088 --token <token> [--canvasId <canvas-id>] [--name "Bot Bob"]
```

Environment variables `WB_BASE_URL`, `WB_TOKEN`, `WB_CANVAS_ID` fill any missing flag.
`--canvasId` is optional: without it the persona joins a board later via the `connect_whiteboard` tool.

## Claude Code wiring

`.mcp.json` example with two personas:

```json
{
  "mcpServers": {
    "whiteboard-alice": {
      "command": "node",
      "args": ["/abs/path/whiteboard-agent-mcp/src/index.js"],
      "env": { "WB_BASE_URL": "http://localhost:8088", "WB_TOKEN": "<alice-token>" }
    },
    "whiteboard-bob": {
      "command": "node",
      "args": ["/abs/path/whiteboard-agent-mcp/src/index.js"],
      "env": { "WB_BASE_URL": "http://localhost:8088", "WB_TOKEN": "<bob-token>" }
    }
  }
}
```

Then give an agent instructions in plain language, for example:
"Watch the board. When a new card appears, drag it 400px to the right over 3 seconds, then rename it."

## Tools

| Tool | Effect |
|---|---|
| `list_whiteboards`, `connect_whiteboard` | find a board and join it by id or name at runtime |
| `create_node`, `edit_node`, `move_node`, `delete_node`, `duplicate_node`, `attach_to_frame` | REST + live mirror |
| `drag_node` | locks the card (and frame children), streams positions live, commits over REST, releases |
| `type_text` | locks the card, streams the growing label or description live, commits over REST |
| `resize_node` | locks the card, streams the size live, commits over REST |
| `style_node`, `convert_node` | toolbar actions: color, font size, alignment, description toggle, issue-list size/query, convert to issue/article |
| `hold_node` | lock cards without moving them (blocks other users from dragging) |
| `create_link`, `edit_link`, `remove_link` | REST + live mirror; edit changes type or swaps direction |
| `move_cursor` | moves the persona's visible cursor, or hides it when called without coordinates |
| `rename_whiteboard` | renames the board for everyone |
| `get_canvas_state` | persisted truth from the database |
| `get_live_state` | what this persona sees over the live channel, plus connected users, cursors and locks |
| `observe_broadcast` | waits for changes made by other users |

If `get_live_state` and `get_canvas_state` disagree, or a peer's change never shows up in
`observe_broadcast`, that is a real propagation bug.

## Manual check with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node src/index.js --baseUrl http://localhost:8088 --token <token> --canvasId <id>
```

## Agent skill

`.agents/skills/whiteboard-user/SKILL.md` tells an agent how to behave like a real user on the board
(cursor first, drag instead of teleport, frame attach/detach, observe before acting).
Symlink it into `~/.claude/skills/` for Claude Code or `~/.codex/skills/` for Codex.
