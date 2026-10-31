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
    /** 立即执行一轮的端点。 */
    const API_RUN = '/api/smueval-bot/run';
    /** 扫描/校验 Token 的端点。 */
    const API_TOKEN_SCAN = '/api/smueval-bot/token/scan';
    /** 走微信浮窗换新 Token 的端点。 */
    const API_TOKEN_WECHAT = '/api/smueval-bot/token/refresh-wechat';
    /** 期末评课程的端点（只在手动点按钮时触发）。 */
    const API_COURSE = '/api/smueval-bot/course/evaluate';
    /** 登录页地址：复制到电脑版微信里点开，Token 就会落到本机。 */
    const LOGIN_URL = 'https://wjiaowu.smu.edu.cn/#/work';
    /** 保存成功后广播，让同页的状态条立刻跟着刷新。 */
    const CONFIG_EVENT = 'smueval-bot:config-changed';
    /** 后台跑完（计划任务/定时器）时的轮询间隔：够及时，也不至于一直敲本机端点。 */
    const REFRESH_MS = 60000;

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
      // 透明底 = 直接用外层 section 的背景，避免"两种底色叠在一起"造成的割裂感；
      // 边框换成更明显的 border-l2，深色主题下也看得清。
      background: 'transparent',
      border: `1px solid ${C.borderStrong}`,
      borderRadius: 6,
      outline: 'none',
      caretColor: C.text,
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
      { group: '界面', key: 'systemTask', label: '注册 Windows 计划任务', hint: '打开后即使没开 DSH 也会自动评课，DSH 内的定时器会主动让位，避免同一天跑两遍。计划任务在整点启动，再随机等 runJitterMinutes 分钟（仅 browser 模式）。', type: 'bool' },

      { group: '评渠道', key: 'channel', label: '评课途径', hint: 'wjiaowu = 用微信 Token 浮窗登录（推荐）；zhjw = 用统一身份认证账号密码 + 验证码（备选）；auto = 优先 wjiaowu，失败自动尝试 zhjw。', type: 'select', options: [
        { value: 'wjiaowu', label: 'wjiaowu（微信 Token，推荐）' },
        { value: 'zhjw', label: 'zhjw（账号密码 + 验证码）' },
        { value: 'auto', label: '自动切换（优先 wjiaowu，失败尝试 zhjw）' },
      ] },
      { group: '评渠道', key: 'zhjwAccount', label: '统一身份认证账号', hint: '学号或工号，与 wjiaowu 同一套账号体系。', type: 'text', placeholder: '学号/工号' },
      { group: '评渠道', key: 'zhjwPassword', label: '统一身份认证密码', hint: '仅保存在本地配置文件中（Base64 编码，非加密），不上传任何服务器。', type: 'text', placeholder: '密码（仅本地保存）' },
      { group: '评渠道', key: 'zhjwMode', label: '登录方式', hint: '浏览器键鼠模拟更真实；纯 HTTP 更快但指纹较弱。', type: 'select', options: [
        { value: 'browser', label: '浏览器键鼠模拟（推荐）' },
        { value: 'http', label: '纯 HTTP 请求' },
      ] },
      { group: '评渠道', key: 'zhjwMaxAttempts', label: '最大尝试次数', hint: '验证码/登录失败后最多重试几次。', type: 'number', placeholder: '3' },
      { group: '评渠道', key: 'zhjwRetryDelayMinutes', label: '失败重试间隔（分钟）', hint: '验证码或登录失败后等多久再试。', type: 'number', placeholder: '15' },
    ];

    const GROUP_HINT = {
      运行: '什么时候跑、跑几门、错过了补不补。',
      评分: '打几星、建议写不写、各道单选题选哪一项。',
      登录: 'Token 一般不用管，插件会自己去电脑版微信里找。',
      浏览器: '看得见的点击比接口调用更难被识别，默认就用浏览器。',
      界面: '插件在 DSH 界面里露不露面、要不要脱离 DSH 运行。',
      评渠道: '选择用哪个入口评课：wjiaowu 是微信 Token 自动登录，zhjw 是统一身份认证账号密码 + ONNX 验证码，作为备选。',
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

    /** 读 body 背景亮度判断深色主题；主题切换时自动更新（不刷新页面）。 */
    function useDarkTheme() {
      const [dark, setDark] = React.useState(false);
      React.useEffect(() => {
        const read = () => {
          try {
            const raw = getComputedStyle(document.body).backgroundColor || '';
            const nums = raw.match(/[\d.]+/g);
            if (!nums || nums.length < 3) return;
            const r = Number(nums[0]);
            const g = Number(nums[1]);
            const b = Number(nums[2]);
            const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            setDark(lum < 0.5);
          } catch {
            // 读不到就当中性处理
          }
        };
        read();
        let observer = null;
        try {
          observer = new MutationObserver(read);
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
          observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        } catch {
          observer = null;
        }
        return () => {
          try {
            if (observer) observer.disconnect();
          } catch {
            // 忽略
          }
        };
      }, []);
      return dark;
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
        // 后台跑完（尤其是计划任务）也要能自己刷新，否则回执会一直停在旧的那次
        let timer = null;
        try {
          timer = window.setInterval(bump, REFRESH_MS);
        } catch {
          timer = null;
        }
        return () => {
          live = false;
          try {
            window.removeEventListener(CONFIG_EVENT, bump);
            if (timer !== null) window.clearInterval(timer);
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
      // 「立即执行」的状态：点下去到服务端回执出现之前，按钮都要禁用
      const [runPending, setRunPending] = React.useState(false);
      const runStartedAt = React.useRef('');
      const lastConfigJson = React.useRef('');
      // Token 扫描 / 监听微信的状态
      const [scanData, setScanData] = React.useState(null);
      const [scanning, setScanning] = React.useState(false);
      const [watchLeft, setWatchLeft] = React.useState(0);
      const [tokenMsg, setTokenMsg] = React.useState('');
      const scanningRef = React.useRef(false);
      const scanRef = React.useRef(null);
      // 二级页签：把配置按用途分类，避免一长条堆在一起
      const [activeTab, setActiveTab] = React.useState('op');
      // 期末评课程：独立按钮触发，平时自动流程不碰
      const [courseBusy, setCourseBusy] = React.useState(false);
      const [courseMsg, setCourseMsg] = React.useState('');
      // 深色/浅色主题探测：靠读 body 背景亮度，切主题不用刷新也能跟上
      const dark = useDarkTheme();
      // 「用微信浮窗刷新 Token」的忙碌态：这个动作要开关微信窗口，可能十几秒
      const [wechatBusy, setWechatBusy] = React.useState(false);

      /** 走微信浮窗换新 Token：唤醒微信 → 点手机图标 → OCR 找条目 → 点开 → 抓 Token。 */
      const refreshViaWeChat = () => {
        if (wechatBusy) return;
        setWechatBusy(true);
        setTokenMsg('正在操作微信：会弹出微信窗口、点开浮窗里的「教学服务平台系统」，请别动鼠标…');
        requestJson(API_TOKEN_WECHAT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then((body) => {
            if (body && body.ok === true) {
              const data = (body.data || {});
              setTokenMsg(data.changed
                ? `已换到新 Token：${data.masked}，已写入配置`
                : `Token 仍是有效的：${data.masked || '(同配置)'}，无需更换`);
              notifyConfigChanged();
              window.setTimeout(() => {
                setWechatBusy(false);
                loaded.reload();
              }, 1500);
              return;
            }
            setWechatBusy(false);
            setTokenMsg((body && body.error) || '微信刷新失败');
          })
          .catch((cause) => {
            setWechatBusy(false);
            setTokenMsg('微信刷新失败：' + String((cause && cause.message) || cause));
          });
      };

      /** 扫一次所有 Token 来源；auto=true 表示监听模式下的静默轮询。 */
      const scanTokens = (auto) => {
        if (scanningRef.current) return;
        scanningRef.current = true;
        setScanning(true);
        if (auto !== true) setTokenMsg('');
        requestJson(API_TOKEN_SCAN, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then((body) => {
            scanningRef.current = false;
            setScanning(false);
            if (!body || body.ok !== true) {
              setTokenMsg((body && body.error) || '扫描失败');
              return;
            }
            const data = body.data || {};
            setScanData(data);
            const hit = (data.candidates || []).find((item) => item.valid);
            if (hit) {
              setWatchLeft(0);
              setTokenMsg(`找到有效 Token（${hit.source === 'wechat' ? '微信端' : '配置里'}）：${hit.masked}`);
              if (auto === true) saveTokenRef.current(hit.token, hit.source === 'wechat' ? '微信端' : '配置里');
            } else if (auto !== true) {
              setTokenMsg(data.wechatCount
                ? `微信里找到 ${data.wechatCount} 个候选，但都已过期。请在电脑版微信里重新点开链接登录一次。`
                : '微信里没找到 wjiaowu 的记录。请在电脑版微信里点开链接登录一次。');
            }
          })
          .catch((cause) => {
            scanningRef.current = false;
            setScanning(false);
            if (auto !== true) setTokenMsg('扫描失败：' + String((cause && cause.message) || cause));
          });
      };
      scanRef.current = scanTokens;

      /** 把某个 Token 写进配置（走同一个 /config 端点，插件会自动重载）。 */
      const saveToken = (token, label) => {
        setTokenMsg('正在写入 Token…');
        requestJson(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch: { token } }),
        })
          .then((body) => {
            if (body && body.ok === true) {
              setTokenMsg(`已写入配置（来源：${label}），插件正在重载…`);
              notifyConfigChanged();
              window.setTimeout(() => loaded.reload(), 1600);
              return;
            }
            setTokenMsg((body && body.error) || '写入失败');
          })
          .catch(() => {
            setTokenMsg('已提交，插件正在重载…');
            notifyConfigChanged();
            window.setTimeout(() => loaded.reload(), 1600);
          });
      };
      const saveTokenRef = React.useRef(saveToken);
      saveTokenRef.current = saveToken;

      const copyLoginLink = () => {
        const done = () =>
          setTokenMsg('链接已复制。打开电脑版微信 → 文件传输助手 → 粘贴发送 → 点开并登录，然后点「监听 3 分钟」。');
        try {
          navigator.clipboard.writeText(LOGIN_URL).then(done, () => setTokenMsg(`复制失败，手动复制：${LOGIN_URL}`));
        } catch {
          setTokenMsg(`手动复制：${LOGIN_URL}`);
        }
      };

      // 监听模式：每 3 秒扫一次，用户去微信点链接，插件自己把新 Token 捡回来
      React.useEffect(() => {
        if (watchLeft <= 0) return undefined;
        const id = window.setInterval(() => {
          if (scanRef.current) scanRef.current(true);
          setWatchLeft((value) => (value <= 3 ? 0 : value - 3));
        }, 3000);
        return () => window.clearInterval(id);
      }, [watchLeft > 0]);

      // 只有配置真的变了才清空草稿；轮询刷新 state 时不要把用户正在改的内容清掉
      React.useEffect(() => {
        const json = JSON.stringify((loaded.data && loaded.data.config) || {});
        if (json === lastConfigJson.current) return;
        lastConfigJson.current = json;
        setDraftState({});
        setPhase('idle');
        setMessage('');
      }, [loaded.data]);

      // 评课进行中：每 3 秒问一次服务端，跑完自然停下
      React.useEffect(() => {
        if (!runPending) return undefined;
        const tick = window.setInterval(() => loaded.reload(), 3000);
        return () => window.clearInterval(tick);
      }, [runPending]);

      // 服务端回执比这次点击更新 → 说明已经跑完了
      React.useEffect(() => {
        if (!runPending) return;
        const lastRun = (loaded.data && loaded.data.state && loaded.data.state.lastRun) || '';
        const stillRunning = !!(loaded.data && loaded.data.state && loaded.data.state.running);
        if (stillRunning) return;
        if (runStartedAt.current === '' || lastRun >= runStartedAt.current) setRunPending(false);
      }, [loaded.data, runPending]);

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
      const running = !!(data.state && data.state.running) || runPending;
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

      /** 立即跑一轮：试运行 = 只点不提交。会真的开浏览器，可能几十秒。 */
      const startRun = (dryRun) => {
        if (running) return;
        runStartedAt.current = new Date().toISOString();
        setRunPending(true);
        setMessage('');
        requestJson(API_RUN, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dryRun: dryRun === true }),
        })
          .then((body) => {
            if (body && body.ok === true) {
              setMessage(dryRun ? '已开始试运行，跑完这里会显示结果…' : '已开始评课，跑完这里会显示结果…');
              window.setTimeout(() => loaded.reload(), 1200);
              return;
            }
            setRunPending(false);
            setMessage((body && body.error) || '启动失败');
          })
          .catch((cause) => {
            setRunPending(false);
            setMessage('启动失败：' + String((cause && cause.message) || cause));
          });
      };

      /** 期末评课程：只有学期末用一次，平时自动评课不包含它。 */
      const startCourseRun = (dryRun) => {
        if (courseBusy) return;
        setCourseBusy(true);
        setCourseMsg(dryRun ? '正在试运行评课程（不提交）…' : '正在评课程，会自己开浏览器逐门点完再提交…');
        requestJson(API_COURSE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dryRun: dryRun === true }),
        })
          .then((body) => {
            setCourseBusy(false);
            const data = body && body.data ? body.data : {};
            if (body && body.ok === true) {
              setCourseMsg(data.message || `完成：${data.evaluated || 0} 门`);
              return;
            }
            setCourseMsg('失败：' + ((body && body.error) || data.message || '未知原因'));
          })
          .catch((cause) => {
            setCourseBusy(false);
            setCourseMsg('失败：' + String((cause && cause.message) || cause));
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
      // ---- 二级页签 ----
      const TABS = [
        { key: 'op', label: '操作' },
        { key: 'timing', label: '定时' },
        { key: 'token', label: 'Token' },
        { key: 'course', label: '评课程' },
        { key: 'advanced', label: '高级' },
      ];
      children.push(h('div', {
        key: 'tabs',
        style: { display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' },
      }, TABS.map((tab) => h('button', {
        key: tab.key,
        type: 'button',
        onClick: () => setActiveTab(tab.key),
        style: {
          padding: '5px 14px',
          fontSize: 12,
          borderRadius: 999,
          border: `1px solid ${activeTab === tab.key ? C.text : C.border}`,
          background: activeTab === tab.key ? C.text : 'transparent',
          color: activeTab === tab.key ? C.surface : C.sub,
          fontWeight: activeTab === tab.key ? 600 : 400,
          cursor: 'pointer',
        },
      }, tab.label))));

      // 「立即执行」放在最上面：这是最常用的动作，不用先滚到底部
      children.push(h('section', {
        key: 'actions-run',
        style: {
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          background: C.surfaceMuted,
          padding: '10px 12px',
          marginBottom: 10,
        },
      }, [
        h('div', { key: 't', style: { fontSize: 13, fontWeight: 600, color: C.text } }, '立即执行'),
        h('div', { key: 'h', style: { fontSize: 12, color: C.faint, marginTop: 2, lineHeight: 1.6 } },
          running ? '正在跑，跑完这里会显示结果（会开一个浏览器窗口，别关它）。' : '手动跑一轮，不用等定时。会真的打开浏览器点页面，你可能看到鼠标自己在动。'),
        h('div', { key: 'b', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 } }, [
          h('button', {
            key: 'run',
            type: 'button',
            disabled: running,
            onClick: () => startRun(false),
            style: {
              padding: '6px 16px',
              fontSize: 13,
              borderRadius: 6,
              border: `1px solid ${running ? C.border : C.text}`,
              // 主按钮用「正文色当底、表面色当字」的反色方案：
              // 这两个 token 本来就是为对比配的一对，深浅主题都保证看得清，
              // 不会像 brand-primary 那样在深色主题里变成一片糊。
              background: running ? C.surfaceMuted : C.text,
              color: running ? C.sub : C.surface,
              cursor: running ? 'default' : 'pointer',
            },
          }, running ? '执行中…' : '立即执行'),
          h('button', {
            key: 'dry',
            type: 'button',
            disabled: running,
            onClick: () => startRun(true),
            style: {
              padding: '6px 12px',
              fontSize: 13,
              borderRadius: 6,
              border: `1px solid ${C.border}`,
              background: 'transparent',
              color: running ? C.faint : C.sub,
              cursor: running ? 'default' : 'pointer',
            },
          }, '试运行（不提交）'),
          message === '' ? null : h('span', {
            key: 'msg',
            style: { fontSize: 12, color: phase === 'failed' ? C.danger : C.sub },
          }, message),
        ]),
      ]));

      // Token 区块：登录态续期。微信端没法被程序驱动开网址（试过，不通），
      // 但可以扫它的本地存储 —— 你在微信里点一次链接，这里就能把新 Token 捡回来。
      const candidates = (scanData && Array.isArray(scanData.candidates)) ? scanData.candidates : [];
      const btnStyle = (primary, disabled) => ({
        padding: '6px 12px',
        fontSize: 13,
        borderRadius: 6,
        // 主按钮反色（正文色做底、表面色做字），渲染结果在深浅主题下都是高对比
        border: `1px solid ${disabled ? C.border : primary ? C.text : C.borderStrong}`,
        background: disabled ? C.surfaceMuted : (primary ? C.text : 'transparent'),
        color: disabled ? C.faint : (primary ? C.surface : C.sub),
        fontWeight: primary ? 600 : 400,
        cursor: disabled ? 'default' : 'pointer',
      });
      children.push(h('section', {
        key: 'token-box',
        style: {
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          background: C.surfaceMuted,
          padding: '10px 12px',
          marginBottom: 10,
        },
      }, [
        h('div', { key: 't', style: { fontSize: 13, fontWeight: 600, color: C.text } }, 'Token（登录态）'),
        h('div', { key: 'h', style: { fontSize: 12, color: C.faint, marginTop: 2, lineHeight: 1.6 } },
          '这个平台的 Token 有效期短。续期最省事的办法：在【电脑版微信】里点开一次登录链接，Token 会落到本机，插件下次自动继承（手机微信不行，数据不会写到这台电脑上）。'),
        h('div', { key: 'b', style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } }, [
          h('button', {
            key: 'scan',
            type: 'button',
            disabled: scanning || watchLeft > 0,
            onClick: () => scanTokens(false),
            style: btnStyle(true, scanning || watchLeft > 0),
          }, scanning ? '扫描中…' : '扫描 Token'),
          h('button', {
            key: 'watch',
            type: 'button',
            disabled: watchLeft > 0,
            onClick: () => {
              setWatchLeft(180);
              setTokenMsg('监听中：现在去电脑版微信点开链接登录，抓到有效 Token 会自动写入。');
              scanTokens(true);
            },
            style: btnStyle(false, watchLeft > 0),
          }, watchLeft > 0 ? `监听中 ${watchLeft}s` : '监听 3 分钟（去微信点链接）'),
          h('button', {
            key: 'wx',
            type: 'button',
            disabled: scanning || watchLeft > 0 || wechatBusy,
            onClick: () => refreshViaWeChat(),
            style: btnStyle(true, scanning || watchLeft > 0 || wechatBusy),
          }, wechatBusy ? '微信刷新中…' : '用微信浮窗刷新 Token'),
          h('button', {
            key: 'copy',
            type: 'button',
            onClick: copyLoginLink,
            style: btnStyle(false, false),
          }, '复制登录链接'),
        ]),
        tokenMsg === '' ? null : h('div', {
          key: 'msg',
          style: { fontSize: 12, color: C.sub, marginTop: 8, lineHeight: 1.6, wordBreak: 'break-all' },
        }, tokenMsg),
        candidates.length === 0 ? null : h('div', { key: 'list', style: { marginTop: 8 } }, candidates.slice(0, 8).map((item, index) =>
          h('div', {
            key: `c${index}`,
            style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.sub, padding: '3px 0' },
          }, [
            h('span', { key: 'v', style: { color: item.valid ? C.ok : C.danger, width: 16 } }, item.valid ? '✅' : '❌'),
            h('span', { key: 's', style: { width: 64, color: C.faint } }, item.source === 'wechat' ? '微信端' : '配置里'),
            h('span', { key: 'm', style: { fontFamily: 'monospace' } }, item.masked),
            item.valid
              ? h('button', {
                  key: 'use',
                  type: 'button',
                  onClick: () => saveToken(item.token, item.source === 'wechat' ? '微信端' : '配置里'),
                  style: { ...btnStyle(false, false), padding: '2px 8px', fontSize: 12 },
                }, '用这个')
              : h('span', { key: 'x', style: { color: C.faint } }, '已过期'),
          ])
        )),
      ]));

      // 期末评课程：独立区块，平时不跑，只有学期末手动点
      children.push(h('section', {
        key: 'course-box',
        style: {
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          background: C.surfaceMuted,
          padding: '10px 12px',
          marginBottom: 10,
        },
      }, [
        h('div', { key: 't', style: { fontSize: 13, fontWeight: 600, color: C.text } }, '期末评课程（手动）'),
        h('div', { key: 'h', style: { fontSize: 12, color: C.faint, marginTop: 2, lineHeight: 1.6 } },
          '整学期只用一次，学期末开放时点。和每天的随堂评课完全分开，自动流程不会碰它。会把「评课程」里所有未评价的课逐门打满星、按常规选项作答并提交。'),
        h('div', { key: 'b', style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } }, [
          h('button', {
            key: 'run',
            type: 'button',
            disabled: courseBusy,
            onClick: () => startCourseRun(false),
            style: {
              padding: '6px 16px',
              fontSize: 13,
              borderRadius: 6,
              border: `1px solid ${courseBusy ? C.border : C.text}`,
              background: courseBusy ? C.surfaceMuted : C.text,
              color: courseBusy ? C.sub : C.surface,
              fontWeight: 600,
              cursor: courseBusy ? 'default' : 'pointer',
            },
          }, courseBusy ? '进行中…' : '评价本学期课程'),
          h('button', {
            key: 'dry',
            type: 'button',
            disabled: courseBusy,
            onClick: () => startCourseRun(true),
            style: btnStyle(false, courseBusy),
          }, '试运行（不提交）'),
          courseMsg === '' ? null : h('span', {
            key: 'msg',
            style: { fontSize: 12, color: C.sub, lineHeight: 1.6 },
          }, courseMsg),
        ]),
      ]));

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
            border: `1px solid ${dirtyKeys.length === 0 ? C.border : C.text}`,
            background: dirtyKeys.length === 0 ? C.surfaceMuted : C.text,
            color: dirtyKeys.length === 0 ? C.sub : C.surface,
            fontWeight: dirtyKeys.length === 0 ? 400 : 600,
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
      const lastResult = st.lastResult || {};
      const sourceLabel = st.lastSource === 'system-task' ? '计划任务' : (st.lastSource === 'dsh' ? 'DSH' : '');
      const verdict = lastResult.finishedAt
        ? `${lastResult.ok ? '✅' : '❌'} ${lastResult.message || (lastResult.ok ? '完成' : '失败')}${sourceLabel ? `（${sourceLabel}）` : ''}`
        : '还没跑过';
      const tasks = st.systemTask && Array.isArray(st.systemTask.tasks) ? st.systemTask.tasks : [];
      const taskLine = st.systemTask && st.systemTask.enabled
        ? (tasks.length > 0 ? `计划任务已注册：${tasks.join('、')}` : `计划任务未注册${st.systemTask.error ? '：' + st.systemTask.error : ''}`)
        : '计划任务：未启用（只在本机 DSH 打开时按时运行）';
      children.push(h('div', {
        key: 'status',
        style: { fontSize: 12, color: C.faint, marginTop: 4, lineHeight: 1.7 },
      }, [
        h('div', { key: 'a' }, `已运行 ${st.runCount || 0} 次 · 上次 ${lastRun} · ${verdict}`),
        h('div', { key: 'b' }, taskLine),
        st.tokenInvalid ? h('div', { key: 'c', style: { color: C.danger } }, '⚠️ Token 已失效，去电脑版微信打开一次 wjiaowu.smu.edu.cn') : null,
      ]));

      // colorScheme 会继承：把它放在根容器上，input/select/滚动条这些原生控件
      // 就会跟着 DSH 的深浅色走，不会出现"深色主题里输入框还是白的"这种冲突。
      // ---- 按页签过滤：设置类分组靠 key（分组名）映射，动作类靠固定 key ----
      const GROUP_TAB = { 运行: 'timing', 界面: 'timing', 登录: 'token', 评分: 'advanced', 浏览器: 'advanced' };
      const KEY_TAB = { 'actions-run': 'op', 'token-box': 'token', 'course-box': 'course' };
      const ALWAYS = new Set(['tabs', 'actions', 'status', 'readonly']);
      const visibleChildren = children.filter((node) => {
        const key = node && node.key;
        if (!key) return true;
        if (ALWAYS.has(key)) return true;
        if (KEY_TAB[key]) return activeTab === KEY_TAB[key];
        if (GROUP_TAB[key]) return activeTab === GROUP_TAB[key];
        return true;
      });

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          marginTop: 4,
          colorScheme: dark ? 'dark' : 'light',
        },
      }, visibleChildren);
    }

    /** 会话输入框下方的状态条；配置里关掉 showStatusBar 就整个不渲染。 */
    function EvalStatus() {
      const loaded = useConfig();
      const values = (loaded.data && loaded.data.config) || {};
      if (values.showStatusBar === false) return null;
      const times = Array.isArray(values.runTimes) && values.runTimes.length > 0 ? values.runTimes.join(' / ') : null;
      const label = values.enabled === false ? '已暂停' : (times === null ? '已启用' : `每天 ${times}`);
      const st = (loaded.data && loaded.data.state) || {};
      const last = st.lastResult || {};
      // 回执：谁跑的（DSH / 计划任务）+ 结果摘要，一眼能看出今天有没有成
      let receipt = null;
      if (last.finishedAt) {
        const source = st.lastSource === 'system-task' ? '计划任务' : 'DSH';
        receipt = last.ok
          ? `上次 ✅ ${last.evaluated || 0} 门（${source}）`
          : `上次 ❌ ${last.tokenInvalid ? 'Token 失效' : '失败'}（${source}）`;
      }
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', fontSize: 12, color: C.sub },
      }, [
        h('span', { key: 'n', style: { fontWeight: 600, color: C.text } }, '南医大评课助手'),
        h('span', { key: 's' }, label),
        receipt === null
          ? null
          : h('span', {
            key: 'r',
            style: { color: last.ok ? C.ok : C.danger },
          }, receipt),
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
