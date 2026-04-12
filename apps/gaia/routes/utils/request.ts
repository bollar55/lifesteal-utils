export const extractBearerToken = (authHeader: string | null) => {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null
    }

    return authHeader.substring(7)
}
