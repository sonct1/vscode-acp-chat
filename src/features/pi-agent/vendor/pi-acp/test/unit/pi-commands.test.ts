import test from 'node:test'
import assert from 'node:assert/strict'
import { PLANNOTATOR_EXTENSION_COMMANDS, toAvailableCommandsFromPiGetCommands } from '../../src/acp/pi-commands.js'

test('toAvailableCommandsFromPiGetCommands: hides extension commands by default and filters skill commands', () => {
  const data = {
    commands: [
      { name: 'x', description: 'X', source: 'extension' },
      { name: 'skill:foo', description: 'Foo', source: 'skill', location: 'user' },
      { name: 'y', source: 'prompt', location: 'project' }
    ]
  }

  const all = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: true }).commands
  assert.deepEqual(all, [
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])

  const includeExt = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: true,
    includeExtensionCommands: true
  }).commands
  assert.deepEqual(includeExt, [
    { name: 'x', description: 'X' },
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])

  const noSkills = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: false }).commands
  assert.deepEqual(noSkills, [{ name: 'y', description: '(prompt:project)' }])
})

test('toAvailableCommandsFromPiGetCommands: allows only configured extension commands', () => {
  const data = {
    commands: [
      { name: 'plannotator', description: 'Plan', source: 'extension' },
      { name: 'plannotator-review', description: 'Review', source: 'extension' },
      { name: 'plannotator-annotate', description: 'Annotate', source: 'extension' },
      { name: 'plannotator-last', description: 'Last', source: 'extension' },
      { name: 'unrelated-extension', description: 'Hidden', source: 'extension' },
      { name: 'prompt-command', description: 'Prompt', source: 'prompt' }
    ]
  }

  const commands = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: true,
    includeExtensionCommands: false,
    allowedExtensionCommands: PLANNOTATOR_EXTENSION_COMMANDS
  }).commands

  assert.deepEqual(commands, [
    { name: 'plannotator', description: 'Plan' },
    { name: 'plannotator-review', description: 'Review' },
    { name: 'plannotator-annotate', description: 'Annotate' },
    { name: 'plannotator-last', description: 'Last' },
    { name: 'prompt-command', description: 'Prompt' }
  ])
})
