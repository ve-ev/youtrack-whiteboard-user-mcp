import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { parseCliArgs } from './cliArgs.js'
import { checkInstanceReachable, verifyToken } from './startup.js'
import { createRestClient } from './restClient.js'
import { connectPersona } from './connection.js'
import { registerTools } from './tools.js'

async function main() {
    const { baseUrl, token, canvasId, name } = parseCliArgs(process.argv.slice(2))
    await checkInstanceReachable(baseUrl)
    const user = await verifyToken(baseUrl, token)
    if (name) user.fullName = name
    console.error(`[whiteboard-agent-mcp] authenticated as ${user.login}`)

    const rest = createRestClient({ baseUrl, token })
    // One live board per persona; connect_whiteboard swaps it.
    const session = {
        canvasId: null,
        connection: null,
        async connect(id) {
            session.connection?.disconnect()
            session.connection = await connectPersona({ baseUrl, token, canvasId: id, user })
            session.canvasId = id
            console.error(`[whiteboard-agent-mcp] connected to whiteboard ${id}`)
        },
    }
    if (canvasId) await session.connect(canvasId)

    const server = new McpServer({ name: 'whiteboard-agent-mcp', version: '0.1.0' })
    registerTools(server, { rest, session })
    await server.connect(new StdioServerTransport())
    console.error('[whiteboard-agent-mcp] MCP server ready on stdio')

    const shutdown = () => { session.connection?.disconnect(); process.exit(0) }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    process.stdin.on('close', shutdown)
}

main().catch((error) => {
    console.error(`[whiteboard-agent-mcp] fatal: ${error.message}`)
    process.exit(1)
})
