import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

export const LOCAL_ACTION_ORIGIN = 'local_action'

async function requestWsTicket(baseUrl, token) {
    const response = await fetch(`${baseUrl}/api/wsTickets/newTicket?fields=ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`POST /api/wsTickets/newTicket failed with ${response.status}`)
    return (await response.json()).ticket
}

// One live Yjs connection per persona: mirrors own mutations out, collects peers' mutations in,
// and broadcasts presence/cursor via awareness like a real browser tab does.
export async function connectPersona({ baseUrl, token, canvasId, user }) {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws/planningCanvases'
    const doc = new Y.Doc()
    const events = []
    let waiter = null

    for (const mapName of ['nodes', 'edges']) {
        const map = doc.getMap(mapName)
        map.observeDeep((yEvents, tr) => {
            if (tr.origin === LOCAL_ACTION_ORIGIN) return
            for (const event of yEvents) {
                if (event.target === map) {
                    event.changes.keys.forEach((change, key) => {
                        events.push({ map: mapName, key, action: change.action, value: map.get(key)?.toJSON?.() })
                    })
                } else {
                    // nested Y.Map field change → report as update of the parent entity
                    const key = event.path[0]
                    const changed = [...event.changes.keys.keys()]
                    events.push({ map: mapName, key, action: 'update', changed, value: map.get(key)?.toJSON?.() })
                }
            }
            waiter?.()
        })
    }

    const provider = new WebsocketProvider(wsUrl, canvasId, doc, {
        params: { ticket: await requestWsTicket(baseUrl, token) },
        disableBc: true,
    })

    // ponytail: WS tickets are one-shot, so refresh the URL before y-websocket's own auto-reconnect fires
    provider.on('status', async ({ status }) => {
        if (status !== 'disconnected') return
        try {
            const ticket = await requestWsTicket(baseUrl, token)
            provider.url = `${wsUrl}/${canvasId}?ticket=${encodeURIComponent(ticket)}`
        } catch (e) {
            console.error(`[whiteboard-agent-mcp] ticket refresh failed: ${e.message}`)
        }
    })

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket connect timed out after 10s')), 10000)
        provider.once('sync', () => { clearTimeout(timer); resolve() })
        provider.once('connection-error', (e) => { clearTimeout(timer); reject(new Error(`WebSocket connection error: ${e?.message ?? e}`)) })
    })

    const awareness = provider.awareness
    const presence = { id: user.id, login: user.login, avatarUrl: user.avatarUrl, name: user.fullName ?? user.login }
    const refreshPresence = () => Object.entries(presence).forEach(([k, v]) => awareness.setLocalStateField(k, v))
    refreshPresence()
    const presenceTimer = setInterval(refreshPresence, 15000)

    return {
        doc,
        get connected() { return provider.wsconnected },
        setCursor(x, y) { awareness.setLocalStateField('cursor', { x, y }) },
        // Same field the browser sets on drag start/stop; browsers block dragging nodes locked by others.
        setNodeLock(nodeIds) { awareness.setLocalStateField('nodeLock', nodeIds?.length ? { nodeIds } : null) },
        lockedBy(nodeId) {
            for (const [clientId, state] of awareness.getStates()) {
                if (clientId !== doc.clientID && state?.nodeLock?.nodeIds?.includes(nodeId)) return state.name ?? state.login
            }
            return null
        },
        peers() {
            const out = []
            awareness.getStates().forEach((state, clientId) => {
                if (clientId !== doc.clientID) out.push({ clientId, ...state })
            })
            return out
        },
        async drainEvents(timeoutMs) {
            if (events.length === 0 && timeoutMs > 0) {
                await new Promise((resolve) => {
                    const t = setTimeout(resolve, timeoutMs)
                    waiter = () => { clearTimeout(t); resolve() }
                })
                waiter = null
            }
            return events.splice(0, events.length)
        },
        disconnect() {
            clearInterval(presenceTimer)
            provider.destroy()
        },
    }
}
