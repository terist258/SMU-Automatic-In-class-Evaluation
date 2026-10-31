window.__ModuleLoader__.load({
  id: '@local/smueval-bot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // Minimal config panel rendered into the conversation composer dock slot.
    // The Host half owns scheduling, tools, and state; this Client half only
    // exposes the configured values back to the user through a small read-only
    // status chip so users can see the plugin is active.
    function EvalStatus({ status }) {
      if (!status) return null;
      const enabled = status.enabled;
      const runs = status.runCount || 0;
      const last = status.lastRun ? new Date(status.lastRun).toLocaleString() : '—';
      const ok = status.lastResult ? (status.lastResult.ok ? '✅' : '❌') : '—';
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          border: '1px solid var(--dsw-alias-border-color, #e5e7eb)',
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-muted, #f3f4f6)',
          fontSize: 12,
          color: 'var(--dsw-alias-text-secondary, #6b7280)',
        },
      }, [
        h('span', { style: { fontWeight: 600 } }, '南医大评课助手'),
        h('span', null, enabled ? '启用' : '停用'),
        h('span', null, `运行 ${runs} 次`),
        h('span', null, `上次：${last}`),
        h('span', null, `结果：${ok}`),
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'smueval-bot-status',
            order: 90,
          }, h(EvalStatus, {}))
        );
      },
    };
  },
});
