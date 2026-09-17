const NODE_FIELDS = 'id,nodeType(id),x,y,width,height,label,description,showDescription,ticketId,articleId,parentFrameId,colorId,query,cardSize,fontSize,textAlignment,imageId'
const LINK_FIELDS = 'id,sourceCard(id),targetCard(id),type(id),linkPrototype(id)'

async function restCall(baseUrl, token, method, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    let parsed = null
    try { parsed = text.length > 0 ? JSON.parse(text) : null } catch { parsed = text }
    if (!response.ok) {
        // MCP SDK only surfaces error.message to the agent, so the body goes into the message.
        throw new Error(`${method} ${path} failed with ${response.status}: ${JSON.stringify(parsed)}`)
    }
    return parsed
}

function pick(obj, keys) {
    return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]))
}

export function createRestClient({ baseUrl, token }) {
    const cards = (canvasId, id = '') => `/api/planningCanvases/${canvasId}/cards${id && '/' + id}?fields=${NODE_FIELDS}`
    return {
        createNode(canvasId, { nodeType, ticketId, articleId, parentFrameId, ...rest }) {
            const body = { nodeType: { id: nodeType }, ...pick(rest, ['label', 'description', 'x', 'y', 'width', 'height']) }
            if (ticketId !== undefined) body.ticket = { id: ticketId }
            if (articleId !== undefined) body.article = { id: articleId }
            if (parentFrameId !== undefined) body.parentFrame = { id: parentFrameId }
            return restCall(baseUrl, token, 'POST', cards(canvasId), body)
        },
        updateNode(canvasId, nodeId, fields) {
            return restCall(baseUrl, token, 'POST', cards(canvasId, nodeId), pick(fields, [
                'label', 'description', 'x', 'y', 'width', 'height',
                'colorId', 'fontSize', 'textAlignment', 'showDescription', 'cardSize', 'query',
            ]))
        },
        convertNode(canvasId, nodeId, { nodeType, idReadable }) {
            const body = { nodeType: { id: nodeType }, label: '' }
            body[nodeType === 'TicketNode' ? 'ticket' : 'article'] = { idReadable }
            return restCall(baseUrl, token, 'POST', cards(canvasId, nodeId), body)
        },
        setParentFrame(canvasId, nodeId, frameId) {
            return restCall(baseUrl, token, 'POST', cards(canvasId, nodeId), { parentFrame: frameId ? { id: frameId } : null })
        },
        // Batch used by the browser for frame placement: [{id, x, y, parentFrame}]
        patchNodes(canvasId, items) {
            const body = items.map((it) => ({ $type: 'PlanningCanvasNode', ...it }))
            return restCall(baseUrl, token, 'PATCH', `/api/planningCanvases/${canvasId}/cards?fields=${NODE_FIELDS}`, body)
        },
        async deleteNode(canvasId, nodeId) {
            await restCall(baseUrl, token, 'DELETE', `/api/planningCanvases/${canvasId}/cards/${nodeId}`)
            return { deleted: nodeId }
        },
        createLink(canvasId, { sourceCardId, targetCardId, type }) {
            const body = { sourceCard: { id: sourceCardId }, targetCard: { id: targetCardId }, type: { id: type } }
            return restCall(baseUrl, token, 'POST', `/api/planningCanvases/${canvasId}/links?fields=${LINK_FIELDS}`, body)
        },
        updateLink(canvasId, linkId, { type, sourceCardId, targetCardId }) {
            const body = {}
            if (type) body.type = { id: type }
            if (sourceCardId) body.sourceCard = { id: sourceCardId }
            if (targetCardId) body.targetCard = { id: targetCardId }
            return restCall(baseUrl, token, 'POST', `/api/planningCanvases/${canvasId}/links/${linkId}?fields=${LINK_FIELDS}`, body)
        },
        renameCanvas(canvasId, name) {
            return restCall(baseUrl, token, 'POST', `/api/planningCanvases/${canvasId}/settings?fields=name`, { name })
        },
        async removeLink(canvasId, linkId) {
            await restCall(baseUrl, token, 'DELETE', `/api/planningCanvases/${canvasId}/links/${linkId}`)
            return { deleted: linkId }
        },
        async listCanvases(query) {
            const q = query ? `&query=${encodeURIComponent(query)}` : ''
            const list = await restCall(baseUrl, token, 'GET', `/api/planningCanvases?fields=id,settings(name)&$top=100${q}`)
            return list.map((c) => ({ id: c.id, name: c.settings?.name ?? '' }))
        },
        getCanvasState(canvasId) {
            return restCall(baseUrl, token, 'GET', `/api/planningCanvases/${canvasId}?fields=id,settings(name),cards(${NODE_FIELDS}),links(${LINK_FIELDS})`)
        },
    }
}
