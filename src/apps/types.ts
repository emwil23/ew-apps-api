import type { z } from 'zod'

/** One AI action an app may call. The prompt is built here on the server; clients only send data. */
export interface AiAction<S extends z.ZodType = z.ZodType> {
  input: S
  /** `ndjson`: one JSON object per line, so clients can render items as they stream in. */
  format: 'ndjson' | 'text'
  maxOutputTokens: number
  system: string
  prompt: (input: z.infer<S>) => string
}

export const defineAction = <S extends z.ZodType>(action: AiAction<S>): AiAction<S> => action
