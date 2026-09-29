/** Browser controls exercising the shipped Workspace draft-initialization API. */
window.__ModuleLoader__.load({
  id: '@fixture/draft-initialization',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('fixtureDraftInitialization', {
          en: {
            panel: 'Draft initialization fixture', workspace: 'Target workspace ID',
            prompt: 'Initial draft JSON', replace: 'Clear previous draft',
            initialize: 'Initialize draft', clear: 'Clear draft without prompt',
            session: 'Target session ID', open: 'Open session',
          },
          zh: {
            panel: '草稿初始化测试', workspace: '目标工作区 ID',
            prompt: '初始草稿 JSON', replace: '清除已有草稿',
            initialize: '初始化草稿', clear: '无提示词清空草稿',
            session: '目标会话 ID', open: '打开会话',
          },
        }))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'fixture-draft-initialization', locale: 'fixtureDraftInitialization',
        }, function DraftInitializationControls({ t }) {
          const [workspaceId, setWorkspaceId] = React.useState('')
          const [sessionId, setSessionId] = React.useState('')
          const [prompt, setPrompt] = React.useState('""')
          const [clearPreviousDraft, setClearPreviousDraft] = React.useState(false)
          return React.createElement('section', {
            'data-draft-initialization': '', 'aria-label': t('panel'),
            style: {
              position: 'fixed', top: 64, right: 16, zIndex: 9999,
              display: 'grid', gap: 4, width: 260,
            },
          },
          React.createElement('input', {
            'aria-label': t('workspace'), value: workspaceId,
            onChange: event => setWorkspaceId(event.target.value),
          }),
          React.createElement('textarea', {
            'aria-label': t('prompt'), value: prompt,
            onChange: event => setPrompt(event.target.value),
          }),
          React.createElement('label', null,
            React.createElement('input', {
              type: 'checkbox', checked: clearPreviousDraft,
              onChange: event => setClearPreviousDraft(event.target.checked),
            }), t('replace')),
          React.createElement('button', {
            type: 'button',
            onClick: () => ctx.uiWorkspace.startSession(workspaceId || undefined, {
              prompt: JSON.parse(prompt), clearPreviousDraft,
            }),
          }, t('initialize')),
          React.createElement('button', {
            type: 'button',
            onClick: () => ctx.uiWorkspace.startSession(workspaceId || undefined, { clearPreviousDraft: true }),
          }, t('clear')),
          React.createElement('input', {
            'aria-label': t('session'), value: sessionId,
            onChange: event => setSessionId(event.target.value),
          }),
          React.createElement('button', {
            type: 'button', onClick: () => ctx.uiWorkspace.openSession(sessionId),
          }, t('open')))
        }))
      },
    }
  },
})
