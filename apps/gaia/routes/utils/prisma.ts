import { Prisma } from '../../generated/prisma/client.ts'
import type { StatusSetter } from './http.ts'

type ErrorResponse = {
    success: false
    error: string
}

type PrismaErrorMapping = {
    status: number
    error: string
}

const KNOWN_ERROR_MAP: Record<string, PrismaErrorMapping> = {
    P2025: { status: 404, error: 'Resource not found' },
    P2003: { status: 404, error: 'Related resource not found' },
    P2000: { status: 400, error: 'Input value too long' }
}

export const handlePrismaError = (error: unknown, set: StatusSetter): ErrorResponse => {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        const mapped = KNOWN_ERROR_MAP[error.code]
        if (mapped) {
            set.status = mapped.status
            return { success: false, error: mapped.error }
        }
    }

    set.status = 500
    return { success: false, error: 'Internal server error' }
}
