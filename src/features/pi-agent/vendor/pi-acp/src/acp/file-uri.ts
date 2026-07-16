import { pathToFileURL } from 'node:url'

export function toFileResourceUri(filePath: string): string {
  return pathToFileURL(filePath, { windows: process.platform === 'win32' }).toString()
}
