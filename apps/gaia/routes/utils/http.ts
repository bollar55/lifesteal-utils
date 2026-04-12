export type StatusSetter = { status?: number | string }

type ErrorResponse = {
    success: false
    error: string
}

const withStatus = (set: StatusSetter, status: number, message: string): ErrorResponse => {
    set.status = status
    return { success: false, error: message }
}

export const badRequest = (set: StatusSetter, message: string) => withStatus(set, 400, message)
export const unauthorized = (set: StatusSetter, message: string) => withStatus(set, 401, message)
export const forbidden = (set: StatusSetter, message: string) => withStatus(set, 403, message)
export const notFound = (set: StatusSetter, message: string) => withStatus(set, 404, message)
export const serverError = (set: StatusSetter, message: string) => withStatus(set, 500, message)
