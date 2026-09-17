export async function checkInstanceReachable(baseUrl) {
    let response
    try {
        response = await fetch(`${baseUrl}/api/config`)
    } catch (cause) {
        throw new Error(
            `No YouTrack instance reachable at ${baseUrl} (${cause.message}). ` +
            `Start one first and check the URL.`
        )
    }
    if (!response.ok) throw new Error(`GET ${baseUrl}/api/config returned ${response.status} — instance is not healthy.`)
}

export async function verifyToken(baseUrl, token) {
    const response = await fetch(`${baseUrl}/api/users/me?fields=id,login,fullName,avatarUrl`, {
        headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`Token verification failed: GET /api/users/me returned ${response.status}. Check --token.`)
    return response.json()
}
