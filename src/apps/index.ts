import { pixe } from './pixe.js'
import { taskpilot } from './taskpilot.js'
import { translateplus } from './translateplus.js'
import type { AiAction } from './types.js'

/** Every app's AI actions. Add an app here to give it `POST /api/ai/<app>/<action>`. */
export const apps: Record<string, Record<string, AiAction>> = { taskpilot, pixe, translateplus }
