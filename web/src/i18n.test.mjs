import assert from 'node:assert/strict'
import { createTranslator, languageOptions, normalizeLanguage, translations } from './i18n.ts'

assert.equal(normalizeLanguage('it'), 'it')
assert.equal(normalizeLanguage('zh-TW'), 'zh-TW')
assert.equal(normalizeLanguage('zh-CN'), 'zh-CN')
assert.equal(normalizeLanguage('zh-Hans'), 'zh-CN')
assert.equal(normalizeLanguage('zh'), 'zh-CN')
assert.equal(normalizeLanguage('zh-HK'), 'zh-TW')
assert.equal(normalizeLanguage('fr'), 'en')
assert.ok(languageOptions.some((language) => language.code === 'zh-TW'))
assert.ok(languageOptions.some((language) => language.code === 'zh-CN'))

const en = createTranslator('en')
const it = createTranslator('it')
const zh = createTranslator('zh-TW')
const zhCN = createTranslator('zh-CN')

assert.equal(en('sessions.title'), 'Sessions')
assert.equal(it('sessions.title'), 'Sessioni')
assert.equal(zh('sessions.title'), '工作階段')

assert.equal(en('sessions.remoteSessionTitle'), 'Remote session')
assert.equal(it('sessions.remoteSessionTitle'), 'Sessione remota')
assert.equal(zh('sessions.remoteSessionTitle'), '遠端工作階段')

assert.equal(en('session.deleteTitle'), 'Delete session?')
assert.equal(it('session.deleteTitle'), 'Eliminare la sessione?')
assert.equal(zh('session.deleteTitle'), '刪除工作階段？')

assert.equal(en('detail.nothingToUndo'), 'Nothing to undo in this session.')
assert.equal(it('detail.nothingToRedo'), 'Non c’è nulla da ripristinare in questa sessione.')
assert.equal(zh('detail.nothingToUndo'), '此工作階段沒有可復原的內容。')

assert.equal(en('detail.sessionActions'), 'Session actions')
assert.equal(it('detail.sessionActions'), 'Azioni sessione')
assert.equal(zh('detail.sessionActions'), '工作階段動作')

// Unknown keys should remain visible during development instead of rendering blank UI.
assert.equal(en('missing.key'), 'missing.key')
assert.equal(en('detail.opencode'), '🤖 OpenCode')
assert.equal(it('detail.changedFilesTitle'), 'File modificati')
assert.equal(zh('detail.changedFilesTitle'), '已變更檔案')
assert.equal(en('detail.linesAddedDeleted', { additions: 3, deletions: 1 }), '+3 lines · -1 lines')
assert.equal(it('detail.aheadBehind', { ahead: 1, behind: 2 }), '1 avanti · 2 indietro')
assert.equal(zh('detail.fileStatusSource'), '來自 /file/status')
assert.equal(en('detail.fileStatusLabel'), 'Changed files')
assert.equal(it('detail.fileStatusLabel'), 'File modificati')
assert.equal(zh('detail.fileStatusLabel'), '已變更檔案')

assert.equal(en('settings.theme'), 'Theme')
assert.equal(it('settings.themeDark'), 'Scuro')
assert.equal(zh('settings.themeSystem'), '跟隨系統')
assert.equal(en('todo.title'), 'Todo Items')

assert.equal(en('action.preparingTool', { tool: 'write' }), 'Preparing write')
assert.equal(it('action.preparingTool', { tool: 'write' }), 'Preparazione di write')
assert.equal(zh('action.preparingTool', { tool: 'write' }), '正在準備 write')
assert.equal(zhCN('sessions.title'), '会话')
assert.equal(zhCN('session.deleteTitle'), '删除会话？')
assert.equal(zhCN('detail.changedFilesTitle'), '已更改文件')
assert.equal(zhCN('settings.themeSystem'), '跟随系统')
assert.equal(zhCN('action.preparingTool', { tool: 'write' }), '正在准备 write')
assert.equal(zhCN('detail.linesAddedDeleted', { additions: 3, deletions: 1 }), '+3 行 · -1 行')
for (const translator of [en, it, zh, zhCN]) {
  assert.match(translator('detail.removeAttachment', { filename: 'photo.png' }), /photo\.png/)
}
for (const translator of [en, it, zh, zhCN]) {
  assert.notEqual(translator('detail.compacting'), 'detail.compacting')
  assert.notEqual(translator('detail.forking'), 'detail.forking')
}

// The unconfirmed-compaction notice must not invite an immediate duplicate compaction, and the
// queued status line must be localized for the shared queue indicator.
assert.ok(
  en('detail.compactUnconfirmed').includes('before compacting again'),
  'the unconfirmed compaction notice must counsel waiting, not an immediate duplicate compaction'
)
assert.ok(
  !en('detail.compactUnconfirmed').includes('compact again if needed'),
  'the unconfirmed compaction notice must not invite an immediate retry'
)
for (const translator of [en, it, zh, zhCN]) {
  assert.notEqual(translator('detail.compactUnconfirmed'), 'detail.compactUnconfirmed')
  assert.notEqual(translator('detail.queuedPrompt'), 'detail.queuedPrompt')
  assert.notEqual(translator('detail.deliveryIndeterminate'), 'detail.deliveryIndeterminate')
}

// The queued-prompt cancel affordance must be localized in every language, so a queued row can
// always offer a labelled way out of the queue.
for (const translator of [en, it, zh, zhCN]) {
  assert.notEqual(translator('detail.cancelQueuedPrompt'), 'detail.cancelQueuedPrompt')
}

assert.equal(en('settings.deleteServerTitle'), 'Delete saved server?')
assert.equal(it('settings.deleteServerTitle'), 'Eliminare il server salvato?')
assert.equal(zh('settings.deleteServerTitle'), '刪除已儲存的伺服器？')

// Disabled session-action explanations and the fork-created notice must exist in every language,
// so a greyed-out Compact/Fork/Undo/Redo can always explain itself in the user's own language.
for (const translator of [en, it, zh, zhCN]) {
  assert.notEqual(translator('detail.actionLocked'), 'detail.actionLocked')
  assert.notEqual(translator('detail.requiresUserMessage'), 'detail.requiresUserMessage')
  assert.notEqual(translator('detail.actionWhileWorking'), 'detail.actionWhileWorking')
  assert.notEqual(translator('detail.forkCreated'), 'detail.forkCreated')
}
assert.ok(en('detail.requiresUserMessage').includes('message'), 'the user-message requirement must be stated in the explanation')
assert.ok(en('detail.actionWhileWorking').includes('idle'), 'the working-state explanation must name the idle condition')
assert.ok(en('detail.forkCreated').includes('session list'), 'the fork-created notice must point at the session list')

// OpenCode 2 structured-part labels (feature #13 lane 2): switches, skill activations, unknown-type
// fallbacks and assistant error/interruption rows must never render a raw key in any language.
for (const translator of [en, it, zh, zhCN]) {
  for (const key of [
    'detail.switchAgent', 'detail.switchAgentTo', 'detail.switchModel', 'detail.switchModelTo',
    'detail.switchLocation', 'detail.switchLocationTo', 'detail.skillActivated',
    'detail.fallbackLabel', 'detail.fallbackTitle', 'detail.assistantError',
    'detail.assistantInterrupted', 'action.exitCode', 'action.shellTimeout', 'action.shellKilled'
  ]) {
    assert.notEqual(translator(key), key, `${key} must be translated in every language`)
  }
}
assert.equal(en('action.exitCode', { n: 0 }), 'exit 0')
assert.equal(en('detail.switchAgent', { from: 'build', to: 'orchestrator' }), 'Switched agent: build → orchestrator')
assert.equal(en('detail.switchAgentTo', { to: 'orchestrator' }), 'Switched agent to orchestrator')
assert.equal(en('detail.fallbackLabel', { typeName: 'snapshot' }), 'Unknown message type (snapshot)')
assert.equal(en('detail.assistantError', { message: 'aborted' }), 'Error: aborted')

// Delegated-subagent run cards and child-session badges (issue #10): every label must exist in
// every language — the open-child control, the collapsible result and the list badge all sit on
// surfaces a non-English user reaches in normal use. The raw tables are asserted directly (not via
// the translator, whose English fallback would mask a missing locale entry).
const SUBAGENT_KEYS = [
  'detail.openChildSession', 'detail.openingChildSession', 'detail.subagentTask',
  'detail.subagentResult', 'detail.showMore', 'detail.showLess', 'detail.subagentElapsed',
  'detail.childSession', 'detail.childSessionOf'
]
for (const language of ['en', 'it', 'zh-TW', 'zh-CN']) {
  for (const key of SUBAGENT_KEYS) {
    assert.ok(
      translations[language][key] !== undefined,
      `${key} must exist in the ${language} table (no English fallback)`
    )
  }
}
for (const translator of [en, it, zh, zhCN]) {
  for (const key of SUBAGENT_KEYS) {
    assert.notEqual(translator(key), key, `${key} must be translated in every language`)
  }
}
assert.equal(en('detail.openChildSession'), 'Open child session')
assert.equal(en('detail.subagentElapsed', { time: '1m 23s' }), 'Elapsed 1m 23s')
assert.equal(en('detail.childSessionOf', { parent: 'Fix the build' }), 'Child session of Fix the build')
assert.equal(en('detail.showMore'), 'Show more')
assert.equal(en('detail.subagentTask'), 'Subagent task')

console.log('i18n tests passed')
