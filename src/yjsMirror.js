import * as Y from 'yjs'
import { LOCAL_ACTION_ORIGIN } from './connection.js'

// Field shapes match extension.js (flat scalars keyed by entity id).
const NODE_KEYS = {
    x: 'x', y: 'y', width: 'width', height: 'height', label: 'label', description: 'description',
    query: 'query', cardSize: 'cardSize', showDescription: 'showDescription', articleId: 'articleId',
    ticketId: 'ticketId', parentFrameId: 'parentId', colorId: 'colorId', fontSize: 'fontSize',
    textAlignment: 'textAlignment', imageId: 'imageId',
}

export function mirrorNodeCreated(doc, node) {
    doc.transact(() => {
        const yNode = new Y.Map()
        for (const [restKey, yKey] of Object.entries(NODE_KEYS)) yNode.set(yKey, node[restKey] ?? null)
        yNode.set('type', node.nodeType.id)
        doc.getMap('nodes').set(node.id, yNode)
    }, LOCAL_ACTION_ORIGIN)
}

export function mirrorNodeUpdated(doc, id, fields) {
    doc.transact(() => {
        const yNode = doc.getMap('nodes').get(id)
        if (!yNode) return
        for (const [key, value] of Object.entries(fields)) {
            if (value !== undefined) yNode.set(NODE_KEYS[key] ?? key, value)
        }
    }, LOCAL_ACTION_ORIGIN)
}

export function mirrorNodeDeleted(doc, id) {
    doc.transact(() => doc.getMap('nodes').delete(id), LOCAL_ACTION_ORIGIN)
}

export function mirrorLinkCreated(doc, link) {
    doc.transact(() => {
        const yEdge = new Y.Map()
        yEdge.set('source', link.sourceCard.id)
        yEdge.set('target', link.targetCard.id)
        yEdge.set('type', link.type.id)
        yEdge.set('text', null)
        yEdge.set('color', null)
        yEdge.set('linkId', link.linkPrototype?.id ?? null)
        doc.getMap('edges').set(link.id, yEdge)
    }, LOCAL_ACTION_ORIGIN)
}

export function mirrorLinkDeleted(doc, id) {
    doc.transact(() => doc.getMap('edges').delete(id), LOCAL_ACTION_ORIGIN)
}
