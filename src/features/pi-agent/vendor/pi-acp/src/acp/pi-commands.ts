import type { AvailableCommand } from '@agentclientprotocol/sdk'

export type PiRpcCommandInfo = {
  name?: unknown
  description?: unknown
  source?: unknown
  location?: unknown
  path?: unknown
}

function describeFallback(c: PiRpcCommandInfo): string {
  const source = typeof c.source === 'string' ? c.source : ''
  const location = typeof c.location === 'string' ? c.location : ''

  const parts: string[] = []
  if (source) parts.push(source)
  if (location) parts.push(location)

  return parts.length ? `(${parts.join(':')})` : '(command)'
}

export type PiAvailableCommandsOptions = {
  enableSkillCommands?: boolean
  includeExtensionCommands?: boolean
  allowedExtensionCommands?: readonly string[]
}

export const PLANNOTATOR_EXTENSION_COMMANDS = [
  'plannotator',
  'plannotator-review',
  'plannotator-annotate',
  'plannotator-last'
] as const

export function toAvailableCommandsFromPiGetCommands(
  data: unknown,
  opts?: PiAvailableCommandsOptions
): {
  commands: AvailableCommand[]
  raw: PiRpcCommandInfo[]
} {
  const enableSkillCommands = opts?.enableSkillCommands ?? true
  const includeExtensionCommands = opts?.includeExtensionCommands ?? false
  const allowedExtensionCommands = opts?.allowedExtensionCommands
    ? new Set<string>(opts.allowedExtensionCommands)
    : null

  const root: any = data
  const commandsRaw: PiRpcCommandInfo[] = Array.isArray(root?.commands)
    ? root.commands
    : Array.isArray(root?.data?.commands)
      ? root.data.commands
      : []

  const out: AvailableCommand[] = []

  for (const c of commandsRaw) {
    const name = typeof c?.name === 'string' ? c.name.trim() : ''
    if (!name) continue

    const source = typeof c?.source === 'string' ? c.source : ''
    if (source === 'extension') {
      if (allowedExtensionCommands) {
        if (!allowedExtensionCommands.has(name)) continue
      } else if (!includeExtensionCommands) {
        continue
      }
    }

    if (!enableSkillCommands && name.startsWith('skill:')) continue

    const desc = typeof c?.description === 'string' ? c.description.trim() : ''

    out.push({
      name,
      description: desc || describeFallback(c)
    })
  }

  return { commands: out, raw: commandsRaw }
}
