import test from 'node:test'
import assert from 'node:assert/strict'
import { toFileResourceUri } from '../../src/acp/file-uri.js'

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const originalPlatform = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: platform })
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
}

test('toFileResourceUri: emits valid POSIX file URI', () => {
  assert.equal(
    withPlatform('linux', () => toFileResourceUri('/tmp/workspace/a b.html')),
    'file:///tmp/workspace/a%20b.html'
  )
})

test('toFileResourceUri: emits valid Windows drive file URI', () => {
  assert.equal(
    withPlatform('win32', () => toFileResourceUri(String.raw`C:\Users\me\workspace\a b.html`)),
    'file:///C:/Users/me/workspace/a%20b.html'
  )
})

test('toFileResourceUri: emits valid Windows UNC file URI', () => {
  assert.equal(
    withPlatform('win32', () => toFileResourceUri(String.raw`\\server\share\a b.html`)),
    'file://server/share/a%20b.html'
  )
})
