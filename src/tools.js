import { z } from 'zod'
import { mirrorNodeCreated, mirrorNodeUpdated, mirrorNodeDeleted, mirrorLinkCreated, mirrorLinkUpdated, mirrorLinkDeleted } from './yjsMirror.js'

const NODE_TYPES = ['TextNode', 'CardNode', 'TicketNode', 'ArticleNode', 'ImageNode', 'WidgetNode', 'FrameNode', 'IssueListNode']
const FONT_SIZES = [10, 12, 14, 18, 24, 36, 48, 64, 80, 144, 288]
const LINK_TYPES = ['ONE_WAY', 'TWO_WAY', 'PROTOTYPED']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Ease-out path (fast start, slow finish) like a human hand; integer coords match the REST DTO.
export function dragPath(from, to, steps) {
    return Array.from({ length: steps }, (_, i) => {
        const t = (i + 1) / steps
        const k = 1 - (1 - t) ** 3
        return { x: Math.round(from.x + (to.x - from.x) * k), y: Math.round(from.y + (to.y - from.y) * k) }
    })
}

export function registerTools(server, { rest, session }) {
    const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
    // Board-scoped tools read the live session; they fail clearly until connect_whiteboard ran.
    const connection = new Proxy({}, { get: (_, prop) => {
        if (!session.connection) throw new Error('Not connected to a whiteboard. Call list_whiteboards, then connect_whiteboard.')
        return session.connection[prop]
    } })

    server.registerTool('list_whiteboards', {
        description: 'List whiteboards this user can access (id and name), optionally filtered by name',
        inputSchema: { query: z.string().optional() },
    }, async ({ query }) => json(await rest.listCanvases(query)))

    server.registerTool('connect_whiteboard', {
        description: 'Join a whiteboard by id or by name. Replaces the current live connection. Required before any other board tool unless --canvasId was given at startup.',
        inputSchema: { canvasId: z.string().optional(), name: z.string().optional() },
    }, async ({ canvasId, name }) => {
        if (!canvasId && !name) throw new Error('Pass canvasId or name')
        let board = { id: canvasId, name }
        if (!canvasId) {
            const matches = await rest.listCanvases(name)
            const exact = matches.filter((c) => c.name.toLowerCase() === name.toLowerCase())
            const pick = exact.length === 1 ? exact : matches
            if (pick.length !== 1) {
                throw new Error(`Expected one whiteboard named "${name}", found ${pick.length}: ${JSON.stringify(matches)}`)
            }
            board = pick[0]
        }
        await session.connect(board.id)
        return json({ connected: true, ...board })
    })

    const nodeFields = {
        label: z.string().optional(),
        description: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
    }
    // Every mutation: REST first (persists), then mirror onto own Yjs doc (peers see it live).
    const mutate = async (restCall, mirror) => {
        const result = await restCall()
        mirror(result)
        return json({ ...result, mirrored: connection.connected })
    }

    server.registerTool('create_node', {
        description: 'Create a card on the whiteboard',
        inputSchema: {
            nodeType: z.enum(NODE_TYPES),
            ...nodeFields,
            x: z.number(), y: z.number(), width: z.number(), height: z.number(),
            ticketId: z.string().optional(),
            articleId: z.string().optional(),
            parentFrameId: z.string().optional().describe('Frame node to place the card inside'),
        },
    }, (args) => mutate(() => rest.createNode(session.canvasId, args), (node) => mirrorNodeCreated(connection.doc, node)))

    server.registerTool('edit_node', {
        description: 'Edit a card: label, description, position or size',
        inputSchema: { id: z.string(), ...nodeFields },
    }, ({ id, ...fields }) => mutate(() => rest.updateNode(session.canvasId, id, fields), () => mirrorNodeUpdated(connection.doc, id, fields)))

    server.registerTool('move_node', {
        description: 'Move a card instantly to a new position (single REST commit)',
        inputSchema: { id: z.string(), x: z.number(), y: z.number() },
    }, ({ id, ...fields }) => mutate(() => rest.updateNode(session.canvasId, id, fields), () => mirrorNodeUpdated(connection.doc, id, fields)))

    server.registerTool('drag_node', {
        description:
            'Drag a card like a mouse drag: streams intermediate positions live to other peers over the ' +
            'collaboration channel for durationMs, then commits the final position over REST. ' +
            'Use this to interfere with another user who is working on the same card.',
        inputSchema: {
            id: z.string(),
            x: z.number(), y: z.number(),
            durationMs: z.number().int().min(50).default(2000),
            steps: z.number().int().min(1).default(20),
        },
    }, async ({ id, x, y, durationMs, steps }) => {
        const nodes = connection.doc.getMap('nodes')
        const current = nodes.get(id)?.toJSON()
        if (!current) throw new Error(`Node ${id} is not in this persona's synced document`)
        const owner = connection.lockedBy(id)
        if (owner) throw new Error(`Node ${id} is being dragged by ${owner}; a real user cannot grab it now`)
        // Lock the node plus, for frames, everything inside it, like the browser does.
        const lockIds = [id, ...[...nodes.entries()].filter(([, n]) => n.get('parentId') === id).map(([k]) => k)]
        const from = { x: current.x, y: current.y }
        const children = lockIds.slice(1).map((cid) => ({ id: cid, ...nodes.get(cid).toJSON() }))
        connection.setNodeLock(lockIds)
        try {
            for (const point of dragPath(from, { x, y }, steps)) {
                const dx = point.x - from.x, dy = point.y - from.y
                mirrorNodeUpdated(connection.doc, id, point)
                for (const c of children) mirrorNodeUpdated(connection.doc, c.id, { x: c.x + dx, y: c.y + dy })
                connection.setCursor(point.x, point.y)
                await sleep(durationMs / steps)
            }
            // Browser: plain drop = one POST per node; frame drop = one PATCH for frame + children.
            const node = children.length === 0
                ? await rest.updateNode(session.canvasId, id, { x, y })
                : (await rest.patchNodes(session.canvasId, [
                    { id, x, y },
                    ...children.map((c) => ({ id: c.id, x: c.x + (x - from.x), y: c.y + (y - from.y), parentFrame: { id } })),
                ]))[0]
            return json({ ...node, from, movedChildren: children.map((c) => c.id), mirrored: connection.connected })
        } finally {
            connection.setNodeLock(null)
        }
    })

    server.registerTool('type_text', {
        description:
            'Type into a card like a person: locks the card, streams the growing text live to other users ' +
            '(whole string every keystroke batch, as the browser does), then commits over REST. ' +
            'Replaces the current text unless append is true.',
        inputSchema: {
            id: z.string(),
            field: z.enum(['label', 'description']).default('label'),
            text: z.string(),
            append: z.boolean().default(false),
            charsPerSecond: z.number().min(1).max(200).default(12),
        },
    }, async ({ id, field, text, append, charsPerSecond }) => {
        const current = connection.doc.getMap('nodes').get(id)?.toJSON()
        if (!current) throw new Error(`Node ${id} is not in this persona's synced document`)
        const owner = connection.lockedBy(id)
        const base = append ? (current[field] ?? '') : ''
        connection.setNodeLock([id])
        try {
            // ponytail: one Yjs write per 100 ms window like the browser, not per character
            const perTick = Math.max(1, Math.round(charsPerSecond / 10))
            for (let i = perTick; i < text.length + perTick; i += perTick) {
                mirrorNodeUpdated(connection.doc, id, { [field]: base + text.slice(0, i) })
                await sleep(100)
            }
            const node = await rest.updateNode(session.canvasId, id, { [field]: base + text })
            return json({ ...node, concurrentEditorAtStart: owner, mirrored: connection.connected })
        } finally {
            connection.setNodeLock(null)
        }
    })

    server.registerTool('resize_node', {
        description:
            'Resize a card by dragging its handle: locks the card, streams the size live, then commits over REST. ' +
            'Cards and text nodes only take width; frames, images, widgets and issue lists take width and height.',
        inputSchema: {
            id: z.string(),
            width: z.number(),
            height: z.number().optional(),
            durationMs: z.number().int().min(50).default(1000),
            steps: z.number().int().min(1).default(10),
        },
    }, async ({ id, width, height, durationMs, steps }) => {
        const current = connection.doc.getMap('nodes').get(id)?.toJSON()
        if (!current) throw new Error(`Node ${id} is not in this persona's synced document`)
        const owner = connection.lockedBy(id)
        if (owner) throw new Error(`Node ${id} is locked by ${owner}`)
        const target = { width, ...(height !== undefined ? { height } : {}) }
        const from = { width: current.width, ...(height !== undefined ? { height: current.height } : {}) }
        connection.setNodeLock([id])
        try {
            for (const p of dragPath({ x: from.width, y: from.height ?? 0 }, { x: width, y: height ?? 0 }, steps)) {
                mirrorNodeUpdated(connection.doc, id, { width: p.x, ...(height !== undefined ? { height: p.y } : {}) })
                await sleep(durationMs / steps)
            }
            const node = await rest.updateNode(session.canvasId, id, target)
            return json({ ...node, from, mirrored: connection.connected })
        } finally {
            connection.setNodeLock(null)
        }
    })

    server.registerTool('duplicate_node', {
        description: 'Duplicate a card (Cmd+D): creates a copy offset from the original',
        inputSchema: { id: z.string(), dx: z.number().default(40), dy: z.number().default(40) },
    }, async ({ id, dx, dy }) => {
        const n = connection.doc.getMap('nodes').get(id)?.toJSON()
        if (!n) throw new Error(`Node ${id} is not in this persona's synced document`)
        const args = {
            nodeType: n.type, x: n.x + dx, y: n.y + dy, width: n.width, height: n.height,
            label: n.label ?? undefined, description: n.description ?? undefined,
            ticketId: n.ticketId ?? undefined, articleId: n.articleId ?? undefined, parentFrameId: n.parentId ?? undefined,
        }
        return mutate(() => rest.createNode(session.canvasId, args), (node) => mirrorNodeCreated(connection.doc, node))
    })

    server.registerTool('edit_link', {
        description: 'Edit a link from its label dropdown: change its type, or swap direction by passing source and target reversed',
        inputSchema: {
            id: z.string(),
            type: z.enum(LINK_TYPES).optional(),
            sourceCardId: z.string().optional(),
            targetCardId: z.string().optional(),
        },
    }, ({ id, ...args }) => mutate(() => rest.updateLink(session.canvasId, id, args), (link) => mirrorLinkUpdated(connection.doc, link)))

    server.registerTool('rename_whiteboard', {
        description: 'Rename the connected whiteboard (visible to everyone)',
        inputSchema: { name: z.string().min(1) },
    }, async ({ name }) => json(await rest.renameCanvas(session.canvasId, name)))

    server.registerTool('hold_node', {
        description:
            'Grab a card without moving it: shows this user\'s lock badge on the card and blocks other users from dragging it, ' +
            'like holding the mouse button down. Call with no ids to release. Locks auto-expire after 30 s in browsers.',
        inputSchema: { ids: z.array(z.string()).default([]) },
    }, ({ ids }) => { connection.setNodeLock(ids); return json({ locked: ids }) })

    // Toolbar actions: what the floating toolbar above a selected card can change.
    server.registerTool('style_node', {
        description:
            'Apply toolbar actions to a card: fill color, font size and text alignment (TextNode), ' +
            'show/hide description (CardNode), card size and query (IssueListNode). Only the given fields change.',
        inputSchema: {
            id: z.string(),
            colorId: z.string().optional().describe('Palette index as string, "1".."37"; "" clears the color'),
            fontSize: z.number().refine((n) => FONT_SIZES.includes(n), `one of ${FONT_SIZES.join(', ')}`).optional(),
            textAlignment: z.enum(['left', 'center', 'right']).optional(),
            showDescription: z.boolean().optional(),
            cardSize: z.enum(['s', 'm', 'l']).optional(),
            query: z.string().optional(),
        },
    }, ({ id, ...fields }) => mutate(() => rest.updateNode(session.canvasId, id, fields), () => mirrorNodeUpdated(connection.doc, id, fields)))

    server.registerTool('convert_node', {
        description: 'Toolbar "convert to issue/article": turn a CardNode or TextNode into a TicketNode or ArticleNode bound to an existing issue/article by readable id (e.g. "PRJ-12")',
        inputSchema: { id: z.string(), nodeType: z.enum(['TicketNode', 'ArticleNode']), idReadable: z.string() },
    }, ({ id, ...args }) => mutate(
        () => rest.convertNode(session.canvasId, id, args),
        (node) => mirrorNodeUpdated(connection.doc, id, {
            type: node.nodeType.id, label: node.label, colorId: node.colorId ?? null,
            ticketId: node.ticketId ?? null, articleId: node.articleId ?? null,
        })
    ))

    server.registerTool('attach_to_frame', {
        description: 'Attach a card to a FrameNode (it moves with the frame). Omit frameId to detach the card from its frame.',
        inputSchema: { id: z.string(), frameId: z.string().optional() },
    }, ({ id, frameId }) => mutate(
        () => rest.setParentFrame(session.canvasId, id, frameId ?? null),
        () => mirrorNodeUpdated(connection.doc, id, { parentFrameId: frameId ?? null })
    ))

    server.registerTool('delete_node', {
        description: 'Delete a card from the whiteboard',
        inputSchema: { id: z.string() },
    }, ({ id }) => mutate(() => rest.deleteNode(session.canvasId, id), () => mirrorNodeDeleted(connection.doc, id)))

    server.registerTool('create_link', {
        description: 'Create a link (arrow) between two cards',
        inputSchema: { sourceCardId: z.string(), targetCardId: z.string(), type: z.enum(LINK_TYPES) },
    }, (args) => mutate(() => rest.createLink(session.canvasId, args), (link) => mirrorLinkCreated(connection.doc, link)))

    server.registerTool('remove_link', {
        description: 'Remove a link between two cards',
        inputSchema: { id: z.string() },
    }, ({ id }) => mutate(() => rest.removeLink(session.canvasId, id), () => mirrorLinkDeleted(connection.doc, id)))

    server.registerTool('move_cursor', {
        description: 'Move this persona\'s live cursor (visible to other users) to canvas coordinates. Call with no coordinates to leave the board (cursor disappears).',
        inputSchema: { x: z.number().optional(), y: z.number().optional() },
    }, ({ x, y }) => { connection.setCursor(x, y); return json({ cursor: x === undefined ? null : { x, y } }) })

    server.registerTool('get_canvas_state', {
        description: 'Full persisted state of the whiteboard from the database: all cards and links',
        inputSchema: {},
    }, async () => json(await rest.getCanvasState(session.canvasId)))

    server.registerTool('get_live_state', {
        description: 'What this persona currently sees over the live collaboration channel: nodes, edges, and other connected users (with cursors and nodeLock = cards they are dragging)',
        inputSchema: {},
    }, () => json({
        nodes: connection.doc.getMap('nodes').toJSON(),
        edges: connection.doc.getMap('edges').toJSON(),
        peers: connection.peers(),
        connected: connection.connected,
    }))

    server.registerTool('observe_broadcast', {
        description:
            'Wait up to timeoutMs for real-time changes made by OTHER users since the last call ' +
            '(own actions excluded). Returns [] on timeout. Use to check whether a peer\'s change reached this persona.',
        inputSchema: { timeoutMs: z.number().int().min(0).max(60000).default(3000) },
    }, async ({ timeoutMs }) => json({ connected: connection.connected, events: await connection.drainEvents(timeoutMs) }))
}
