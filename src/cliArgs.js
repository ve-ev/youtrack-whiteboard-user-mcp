import { parseArgs } from 'node:util'

// ponytail: CLI flags win, env vars (WB_BASE_URL/WB_TOKEN/WB_CANVAS_ID) fill gaps — enough for MCP configs
export function parseCliArgs(argv, env = process.env) {
    const { values } = parseArgs({
        args: argv,
        options: {
            baseUrl: { type: 'string' },
            token: { type: 'string' },
            canvasId: { type: 'string' },
            name: { type: 'string' },
        },
    })
    const baseUrl = values.baseUrl ?? env.WB_BASE_URL
    const token = values.token ?? env.WB_TOKEN
    const canvasId = values.canvasId ?? env.WB_CANVAS_ID

    const missing = Object.entries({ baseUrl, token }).filter(([, v]) => !v).map(([k]) => `--${k}`)
    if (missing.length > 0) throw new Error(`Missing required argument(s): ${missing.join(', ')}`)

    return { baseUrl: baseUrl.replace(/\/+$/, ''), token, canvasId, name: values.name }
}
