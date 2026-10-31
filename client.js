window.__ModuleLoader__.load({
  id: '@local/smueval-bot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 包名：插件页按这个 key 找本 bundle 的配置格子。 */
    const PKG = '@local/smueval-bot';
    /** loader 条目 id：cordis.patch.yml 里 insert 的 id，单行配置页的 key 后半段。 */
    const ENTRY = 'smueval-bot';
    /** 本插件自己开的配置端点（Host 半侧注册，只监听回环）。 */
    const API = '/api/smueval-bot/config';
    /** 保存成功后广播，让同页的状态条立刻跟着刷新。 */
    const CONFIG_EVENT = 'smueval-bot:config-changed';

    // 只用 DSH 真实存在的主题 token（浅色/深色各自有值），并给浅色兜底。
    // 之前写的是 --dsw-alias-bg-input / --dsw-alias-label-tertiary 这类不存在的
    // 变量名，兜底成白底，深色主题下就成了「白底白字」。
    const C = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      sub: 'var(--dsw-alias-label-secondary, #6b7280)',
      faint: 'var(--dsw-alias-label-secondary, #9ca3af)',
      border: 'var(--dsw-alias-border-l1, #e5e7eb)',
      borderStrong: 'var(--dsw-alias-border-l2, #d1d5db)',
      surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      surfaceMuted: 'var(--dsw-alias-bg-layer-2, #f6f7f8)',
      link: 'var(--dsw-alias-brand-primary, #2563eb)',
      danger: 'var(--dsw-alias-state-error-primary, #c0392b)',
      ok: 'var(--dsw-alias-state-success-primary, #1a7f37)',
    };

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '5px 8px',
      fontSize: 13,
      color: C.text,
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      outline: 'none',
      colorScheme: 'inherit',
    };

    const FIELDS = [
      { group: '运行', key: 'enabled', label: '定时评课', hint: '关闭后不再自动运行；手动工具仍然可用。', type: 'bool' },
      { group: '运行', key: 'runTimes', label: '每天运行时间', hint: '24 小时制，多个时间用逗号隔开，例如 12:00, 20:30。', type: 'times', placeholder: '20:30' },
      { group: '运行', key: 'runJitterMinutes', label: '时间随机浮动（分钟）', hint: '实际触发 = 设定时间 ± 该分钟数，避免每天整点提交。', type: 'number' },
      { group: '运行', key: 'lookbackDays', label: '补评天数', hint: '0 = 只评今天；1 = 今天和昨天。', type: 'number' },
      { group: '运行', key: 'dryRun', label: '试运行', hint: '只走一遍页面、不提交。', type: 'bool' },
      { group: '运行', key: 'catchUpOnStart', label: '错过就补跑', hint: '定时点电脑没开机时，下次启动补一次。', type: 'bool' },

      { group: '评分', key: 'fourStarCount', label: '四星题数', hint: '4 道评分题里打四星的题数，其余五星。2 = 90 分。', type: 'number' },
      { group: '评分', key: 'varyFourStar', label: '四星位置随机', hint: '每节课随机挑哪几道打四星。', type: 'bool' },
      { group: '评分', key: 'fillSuggestion', label: '填写意见建议', hint: '关闭则建议栏一律留空。', type: 'bool' },
      { group: '评分', key: 'suggestionEmptyRate', label: '建议留空比例', hint: '0 到 1，0.35 = 约 35% 的课不写建议。', type: 'number' },
      { group: '评分', key: 'lateAnswer', label: '「是否迟到」选项', hint: '必须和页面上的选项文字完全一致。', type: 'text', placeholder: '否' },
      { group: '评分', key: 'dutyAnswer', label: '「职务」选项', type: 'text', placeholder: '无职务' },
      { group: '评分', key: 'requirementAnswer', label: '「学习要求」选项', type: 'text', placeholder: '按要求完成了学习' },
      { group: '评分', key: 'selfStudyAnswer', label: '「自学情况」选项', type: 'text', placeholder: '课程学时30%以内' },

      { group: '登录', key: 'token', label: '手动 Token', hint: '留空表示自动从电脑版微信 / 本机浏览器读取；已保存的 Token 不回显，只有填了新内容才会覆盖。', type: 'token', placeholder: '留空自动读取' },
      { group: '登录', key: 'readWeChatToken', label: '自动读取微信 Token', hint: '从电脑版微信的本地存储里取最新 Token。', type: 'bool' },

      { group: '浏览器', key: 'mode', label: '运行方式', hint: 'browser = 真实浏览器点击（推荐）；api = 直接调接口（快，但指纹明显）。', type: 'select', options: [
        { value: 'browser', label: 'browser（真实浏览器）' },
        { value: 'api', label: 'api（直接调接口）' },
      ] },
      { group: '浏览器', key: 'headless', label: '后台静默运行', hint: '关闭 = 显示窗口，能看到它自己点。', type: 'bool' },
      { group: '浏览器', key: 'useRealViewport', label: '使用真实窗口尺寸', type: 'bool' },
      { group: '浏览器', key: 'seedProfile', label: '同步本机浏览器资料', hint: '复制历史记录和 Cookie，避免「全新空 profile」特征。', type: 'bool' },

      { group: '界面', key: 'showStatusBar', label: '显示底部状态条', hint: '关掉后聊天输入框下方不再显示「南医大评课助手 · 每天 20:30」。', type: 'bool' },
    ];

    const GROUP_HINT = {
      运行: '什么时候跑、跑几门、错过了补不补。',
      评分: '打几星、建议写不写、各道单选题选哪一项。',
      登录: 'Token 一般不用管，插件会自己去电脑版微信里找。',
      浏览器: '看得见的点击比接口调用更难被识别，默认就用浏览器。',
      界面: '插件在 DSH 界面里露不露面。',
    };

    function textOf(spec, value) {
      if (value === undefined || value === null) return '';
      if (spec.type === 'times') return Array.isArray(value) ? value.join(', ') : String(value);
      if (typeof value === 'object') return '';
      return String(value);
    }

    /** 把输入框里的文字变成要写进配置的值；返回 undefined 表示「不改这一项」。 */
    function parseOf(spec, text) {
      const raw = typeof text === 'string' ? text.trim() : text;
      if (raw === '' || raw === undefined || raw === null) return undefined;
      if (spec.type === 'number') {
        const num = Number(raw);
        return Number.isFinite(num) ? num : undefined;
      }
      if (spec.type === 'times') {
        const parts = String(raw).split(/[,，\s]+/).map((part) => part.trim()).filter((part) => /^\d{1,2}:\d{2}$/.test(part));
        return parts.length === 0 ? undefined : parts;
      }
      return String(raw);
    }

    /**
     * 请求自己的配置端点。桌面壳层的页面跑在 dsh-app:// 自定义协议下，
     * 相对路径的 fetch 有可能直接抛 "Failed to parse URL"，而组件里抛异常会让
     * 整棵 React 树白屏。所以这里把 URL 解析和 fetch 都包起来，只返回 Promise。
     */
    function requestJson(path, init) {
      return new Promise((resolve, reject) => {
        let url = path;
        try {
          url = new URL(path, window.location.href).toString();
        } catch {
          url = path;
        }
        let response;
        try {
          response = fetch(url, init);
        } catch (error) {
          reject(error);
          return;
        }
        Promise.resolve(response)
          .then((reply) => reply.json())
          .then(resolve)
          .catch(reject);
      });
    }

    /** 保存成功后广播一次，让同页的状态条立即重读配置。 */
    function notifyConfigChanged() {
      try {
        window.dispatchEvent(new Event(CONFIG_EVENT));
      } catch {
        // 没有 window 就算了
      }
    }

    /** 读一次配置；组件里用，失败给出可读原因。 */
    function useConfig() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });
      const [nonce, setNonce] = React.useState(0);
      React.useEffect(() => {
        let live = true;
        setState((prev) => (prev.phase === 'loading' ? prev : { phase: 'loading', data: prev.data, error: null }));
        requestJson(API, { cache: 'no-store' })
          .then((body) => {
            if (!live) return;
            if (body && body.ok === true) setState({ phase: 'ready', data: body.data, error: null });
            else setState({ phase: 'failed', data: null, error: (body && body.error) || '读取配置失败' });
          })
          .catch((cause) => {
            if (!live) return;
            setState({ phase: 'failed', data: null, error: String((cause && cause.message) || cause) });
          });
        // 面板保存成功后广播，状态条不必等下一轮会话就跟着变
        const bump = () => setNonce((value) => value + 1);
        try {
          window.addEventListener(CONFIG_EVENT, bump);
        } catch {
          // 没有 window 就算了
        }
        return () => {
          live = false;
          try {
            window.removeEventListener(CONFIG_EVENT, bump);
          } catch {
            // 忽略
          }
        };
      }, [nonce]);
      return { ...state, reload: () => setNonce((value) => value + 1) };
    }

    function rowShell(spec, control, footer) {
      return h('div', {
        key: spec.key,
        style: {
          display: 'grid',
          gridTemplateColumns: 'minmax(150px, 210px) minmax(0, 1fr)',
          gap: 12,
          alignItems: 'start',
          padding: '8px 0',
          borderTop: `1px solid ${C.border}`,
        },
      }, [
        h('div', { key: 'l', style: { minWidth: 0 } }, [
          h('div', { key: 't', style: { fontSize: 13, color: C.text } }, spec.label),
          spec.hint ? h('div', { key: 'h', style: { fontSize: 12, color: C.faint, marginTop: 2, lineHeight: 1.5 } }, spec.hint) : null,
        ]),
        h('div', { key: 'c', style: { minWidth: 0 } }, [control, footer || null]),
      ]);
    }

    function Field(props) {
      const { spec, values, draft, setDraft, disabled } = props;
      const value = values ? values[spec.key] : undefined;

      if (spec.type === 'bool') {
        return rowShell(spec, h('label', {
          key: 'k',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            cursor: disabled ? 'default' : 'pointer',
            fontSize: 13,
            color: C.text,
          },
        }, [
          h('input', {
            key: 'i',
            type: 'checkbox',
            checked: value === true,
            disabled,
            onChange: (event) => setDraft(spec.key, event.target.checked),
            style: { width: 15, height: 15, accentColor: C.link },
          }),
          h('span', { key: 's' }, value === true ? '开启' : '关闭'),
        ]));
      }

      if (spec.type === 'select') {
        const options = spec.options;
        const current = value === undefined || value === null ? options[0].value : String(value);
        return rowShell(spec, h('select', {
          key: 'k',
          value: current,
          disabled,
          onChange: (event) => setDraft(spec.key, event.target.value),
          style: { ...inputStyle, height: 30 },
        }, options.map((option) => h('option', {
          key: option.value,
          value: option.value,
          // 原生下拉面板不跟主题变量走；显式给深色字 + 浅色底，免得深色主题下白底白字。
          style: { color: '#1f2328', background: '#ffffff' },
        }, option.label))));
      }

      const shown = draft === undefined ? textOf(spec, value) : draft;
      return rowShell(spec, h('input', {
        key: 'k',
        type: 'text',
        value: shown,
        disabled,
        inputMode: spec.type === 'number' ? 'decimal' : 'text',
        placeholder: spec.type === 'token' && value !== undefined && props.tokenConfigured ? '已保存（留空不改）' : (spec.placeholder || ''),
        onChange: (event) => setDraft(spec.key, event.target.value),
        style: inputStyle,
      }));
    }

    /** 插件页 bundle 详情里的配置面板（官方挂点：plugins.bundle.config，key = 包名）。 */
    function BundleConfig(props) {
      const loaded = useConfig();
      const [draft, setDraftState] = React.useState({});
      const [phase, setPhase] = React.useState('idle');
      const [message, setMessage] = React.useState('');

      React.useEffect(() => {
        setDraftState({});
        setPhase('idle');
        setMessage('');
      }, [loaded.data]);

      if (props && props.view === 'summary') {
        const values = (loaded.data && loaded.data.config) || {};
        const ready = loaded.data !== null && loaded.data !== undefined;
        const times = Array.isArray(values.runTimes) ? values.runTimes.join(' / ') : null;
        if (!ready || times === null) return h('span', null, '自动完成南医大随堂评价');
        return h('span', null, values.enabled === false ? '已暂停自动评课' : `每天 ${times} 自动完成随堂评价`);
      }

      if (loaded.phase === 'loading' && loaded.data === null) {
        return h('div', { style: { fontSize: 13, color: C.sub, padding: '8px 0' } }, '正在读取配置…');
      }
      if (loaded.phase === 'failed') {
        return h('div', { style: { fontSize: 13, color: C.text, padding: '8px 0', lineHeight: 1.7 } }, [
          h('div', { key: 'e', style: { color: C.danger, fontWeight: 600 } }, '读不到配置'),
          h('div', { key: 'a', style: { color: C.sub, marginTop: 4 } }, `${loaded.error}`),
          h('div', { key: 'b', style: { color: C.faint, marginTop: 6, fontSize: 12 } },
            '可能原因：刚装上的版本还没刷新页面；或这个 DSH 版本没有本地配置端点。可以先按 Ctrl+R 刷新一次，仍然失败就到 cordis.patch.yml 里改（条目 id：smueval-bot）。'),
        ]);
      }

      const data = loaded.data || {};
      const values = data.config || {};
      const disabled = data.writable !== true;
      const dirtyKeys = Object.keys(draft).filter((key) => {
        const spec = FIELDS.find((item) => item.key === key);
        if (spec === undefined) return false;
        if (spec.type === 'bool' || spec.type === 'select') return draft[key] !== values[key];
        return String(draft[key]).trim() !== textOf(spec, values[key]);
      });

      const setDraft = (key, value) => {
        setDraftState((prev) => ({ ...prev, [key]: value }));
        setMessage('');
      };

      const save = () => {
        const patch = {};
        for (const key of dirtyKeys) {
          const spec = FIELDS.find((item) => item.key === key);
          if (spec === undefined) continue;
          if (spec.type === 'bool' || spec.type === 'select') {
            patch[key] = draft[key];
            continue;
          }
          const parsed = parseOf(spec, String(draft[key]));
          if (parsed !== undefined) patch[key] = parsed;
        }
        if (Object.keys(patch).length === 0) {
          setMessage('没有可保存的改动（时间格式要写成 20:30）。');
          return;
        }
        setPhase('saving');
        setMessage('');
        requestJson(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch }),
        })
          .then((body) => {
            if (body && body.ok === true) {
              setPhase('applied');
              setMessage('已保存，正在重载插件…');
              notifyConfigChanged();
              window.setTimeout(() => {
                loaded.reload();
              }, 1600);
              return;
            }
            setPhase('failed');
            setMessage((body && body.error) || '保存失败');
          })
          .catch((cause) => {
            // 写入会重载插件并重建路由，回包可能直接断在这里；等同于已提交。
            setPhase('applied');
            setMessage('已提交，正在重载插件…');
            notifyConfigChanged();
            window.setTimeout(() => {
              loaded.reload();
            }, 1600);
          });
      };

      const groups = [];
      for (const spec of FIELDS) {
        let group = groups.find((item) => item.name === spec.group);
        if (group === undefined) {
          group = { name: spec.group, items: [] };
          groups.push(group);
        }
        group.items.push(spec);
      }

      const children = [];
      if (disabled) {
        children.push(h('div', {
          key: 'readonly',
          style: {
            fontSize: 12,
            color: C.sub,
            background: C.surfaceMuted,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: '6px 10px',
            marginBottom: 8,
            lineHeight: 1.7,
          },
        }, [
          h('div', { key: 't', style: { fontWeight: 600, color: C.text } }, '这个部署不支持在线改配置'),
          h('div', { key: 'p' }, data.patchPath
            ? `请直接编辑：${data.patchPath}（条目 id：${data.entryId || 'smueval-bot'}）`
            : `请编辑 profile 的 cordis.patch.yml（条目 id：${data.entryId || 'smueval-bot'}）`),
        ]));
      }
      for (const group of groups) {
        children.push(h('section', { key: group.name, style: { marginBottom: 6 } }, [
          h('div', { key: 'head', style: { marginTop: 10 } }, [
            h('div', { key: 'name', style: { fontSize: 13, fontWeight: 600, color: C.text } }, group.name),
            h('div', { key: 'hint', style: { fontSize: 12, color: C.faint, marginTop: 2 } }, GROUP_HINT[group.name] || ''),
          ]),
          ...group.items.map((spec) => h(Field, {
            key: spec.key,
            spec,
            values,
            draft: draft[spec.key],
            setDraft,
            disabled: disabled || phase === 'saving',
            tokenConfigured: values.tokenConfigured === true,
          })),
        ]));
      }

      children.push(h('div', {
        key: 'actions',
        style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 },
      }, [
        h('button', {
          key: 'save',
          type: 'button',
          disabled: disabled || phase === 'saving' || dirtyKeys.length === 0,
          onClick: save,
          style: {
            padding: '6px 16px',
            fontSize: 13,
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: dirtyKeys.length === 0 ? C.surfaceMuted : C.link,
            color: dirtyKeys.length === 0 ? C.sub : '#fff',
            cursor: disabled || dirtyKeys.length === 0 ? 'default' : 'pointer',
          },
        }, phase === 'saving' ? '保存中…' : (dirtyKeys.length === 0 ? '保存' : `保存 ${dirtyKeys.length} 项`)),
        h('button', {
          key: 'reset',
          type: 'button',
          disabled: disabled || dirtyKeys.length === 0,
          onClick: () => {
            setDraftState({});
            setMessage('');
          },
          style: {
            padding: '6px 12px',
            fontSize: 13,
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: 'transparent',
            color: C.sub,
            cursor: dirtyKeys.length === 0 ? 'default' : 'pointer',
          },
        }, '撤销改动'),
        message === ''
          ? null
          : h('span', {
            key: 'msg',
            style: { fontSize: 12, color: phase === 'failed' ? C.danger : C.ok },
          }, message),
      ]));

      const st = data.state || {};
      const lastRun = st.lastRun ? new Date(st.lastRun).toLocaleString() : '—';
      children.push(h('p', {
        key: 'status',
        style: { fontSize: 12, color: C.faint, marginTop: 4, lineHeight: 1.6 },
      }, `已运行 ${st.runCount || 0} 次 · 上次 ${lastRun}${st.tokenInvalid ? ' · ⚠️ Token 已失效' : ''}`));

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 } }, children);
    }

    /** 会话输入框下方的状态条；配置里关掉 showStatusBar 就整个不渲染。 */
    function EvalStatus() {
      const loaded = useConfig();
      const values = (loaded.data && loaded.data.config) || {};
      if (values.showStatusBar === false) return null;
      const times = Array.isArray(values.runTimes) && values.runTimes.length > 0 ? values.runTimes.join(' / ') : null;
      const label = values.enabled === false ? '已暂停' : (times === null ? '已启用' : `每天 ${times}`);
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', fontSize: 12, color: C.sub },
      }, [
        h('span', { key: 'n', style: { fontWeight: 600, color: C.text } }, '南医大评课助手'),
        h('span', { key: 's' }, label),
      ]);
    }

    return {
      inject: ['slots'],
      // 这个 apply 里任何一步都不允许把异常抛出去：客户端的 一个 entry 抛错，
      // 整个页面就「web boot: entry did not activate」，DSH 直接打不开
      // （2026-10-31 真出过一次）。所以每个挂点都单独 try/catch，缺槽位就安静跳过。
      apply(ctx) {
        /** 已经注册过 bundle.config 的 key，避免包名探测重复注册。 */
        const registered = new Set([PKG, ENTRY]);
        const warn = (what, error) => {
          try {
            console.warn(`[smueval-bot] ${what} 未挂载：${error && error.message ? error.message : error}`);
          } catch {
            // 连 console 都没有就算了
          }
        };

        /** 往一个 slot 注册若干 key；缺槽位/缺 API 都只警告，不抛。 */
        const registerKeys = (slot, pairs) => {
          try {
            ctx.slots.inject(slot, () => {
              const disposers = [];
              for (const [key, Component] of pairs) {
                try {
                  disposers.push(ctx.slots.register({ name: slot, key }, Component));
                } catch (error) {
                  warn(`${slot}(${key})`, error);
                }
              }
              return () => {
                for (const dispose of disposers) {
                  try {
                    dispose();
                  } catch {
                    // 卸载期的异常不用管
                  }
                }
              };
            });
          } catch (error) {
            warn(slot, error);
          }
        };

        // 面板挂点按「安装时的包名」派发；发布成别的名字就对不上，而且不报错。
        // 常见两种名字都先注册（多注册的 key 没人派发，就是空气）。
        registerKeys('plugins.bundle.config', [[PKG, BundleConfig], [ENTRY, BundleConfig]]);
        // 只派发单行配置页的老版本 DSH 走这里
        registerKeys('plugins.row.config', [[`${PKG}#${ENTRY}`, BundleConfig], [`${ENTRY}#${ENTRY}`, BundleConfig]]);

        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register({
              name: 'conversation.composer.dock',
              id: 'smueval-bot-status',
              order: 90,
            }, EvalStatus));
        } catch (error) {
          warn('conversation.composer.dock', error);
        }

        // 包名探测：延后 1.2 秒、全程 try/catch，绝不在 boot 的关键路径上。
        // 读到 Host 报的真实包名后再补注册一份，兼容改名发布的版本。
        try {
          ctx.effect(() => {
            let cancelled = false;
            const extras = [];
            const timer = setTimeout(() => {
              const apply_ = (body) => {
                if (cancelled) return;
                const name = body && body.ok === true && body.data ? body.data.packageName : undefined;
                if (typeof name !== 'string' || name === '') return;
                const candidates = [name, name.split('/').pop()];
                for (const candidate of candidates) {
                  if (typeof candidate !== 'string' || candidate === '' || registered.has(candidate)) continue;
                  registered.add(candidate);
                  try {
                    extras.push(ctx.slots.register({ name: 'plugins.bundle.config', key: candidate }, BundleConfig));
                  } catch (error) {
                    warn(`plugins.bundle.config(${candidate})`, error);
                  }
                  try {
                    extras.push(ctx.slots.register({ name: 'plugins.row.config', key: `${candidate}#${ENTRY}` }, BundleConfig));
                  } catch (error) {
                    warn(`plugins.row.config(${candidate})`, error);
                  }
                }
              };
              try {
                requestJson(API, { cache: 'no-store' }).then(apply_).catch(() => {});
              } catch (error) {
                warn('配置端点探测', error);
              }
            }, 1200);
            return () => {
              cancelled = true;
              clearTimeout(timer);
              for (const dispose of extras) {
                try {
                  dispose();
                } catch {
                  // 忽略
                }
              }
            };
          }, 'smueval-bot: package name probe');
        } catch (error) {
          warn('包名探测', error);
        }
      },
    };
  },
});
