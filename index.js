/** Host half of the SMU Teaching Evaluation Bot plugin (smueval-bot).
 *
 * 目标：南方医科大学「教学服务平台」移动端的【随堂评价】（每节课一次）
 *   前端 https://wjiaowu.smu.edu.cn/  (Vue SPA)
 *   接口 https://wjiaowu.smu.edu.cn/dev-api/
 *   认证：localStorage.Token → 以 `token` 请求头发送（不是 Cookie）
 *
 * 随堂评价链路（逆向 + 实测跑通）：
 *   1) POST /appapi/Studentpjwj/clazz {xnxqdm}        → 待评课节列表 allPjxxList
 *   2) POST /appapi/Studentpjwj/pjClass {dgksdm,teadm} → 问卷 wtList + skInfo
 *   3) POST /appapi/Studentpjwj/saveClassPj            → 提交
 *
 * 随堂问卷结构（7 项）：
 *   txdm=5 ×4  评分题，各 25 分（教师仪态 / 教学目标 / 点评到位 / 学习促进）
 *   txdm=1 ×1  教师是否迟到 5 分钟以上 → 选「否」
 *   txdm=3 ×1  问题和建议（选填）
 *   txdm=-1    总分占位行，不提交
 *
 * 评分习惯（用户真实习惯）：4 道评分题里 2 个四星 + 2 个五星 → 总分 90。
 *
 * 注意：Token 来自微信登录后的 localStorage，会过期；
 * 失效时接口返回 code 401「请先登录！」，需用户重新提供。
 */

const PLUGIN = "smueval-bot";
export const inject = ["timer", "tools", "storage"];
// 工具名必须匹配 ^[a-zA-Z0-9_-]+$，不能用斜杠
const TOOL_PREFIX = `${PLUGIN}-`;
const DEFAULT_RUN_TIMES = ["20:30"];
const DEFAULT_API_BASE = "https://wjiaowu.smu.edu.cn/dev-api";
const DEFAULT_SUGGESTION = "课程内容充实，教学认真负责，受益匪浅。";

import { runBrowserRun } from "./browser.js";
import z from "@deepseek-ai/schemastery";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 记录「今天是否已经跑过」，用于开机补跑判断 */
const STATE_FILE = path.join(os.homedir(), ".smueval-bot-state.json");

function readPersistedState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writePersistedState(next) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(next), "utf8");
  } catch {}
}

function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- 通用工具 ----------

function nowIso() {
  return new Date().toISOString();
}

function parseHhMm(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return { h: h || 0, m: m || 0 };
}

function nextRunTime(runTimes, ref = new Date(), jitterMinutes = 0) {
  const candidates = runTimes.map((t) => {
    const { h, m } = parseHhMm(t);
    const d = new Date(ref);
    d.setHours(h, m, 0, 0);
    if (d <= ref) d.setDate(d.getDate() + 1);
    // 随机偏移：不再精准整点，避免“每天 12:00:00 准时评课”这种机器特征
    if (jitterMinutes > 0) {
      const offset = Math.floor((Math.random() * 2 - 1) * jitterMinutes * 60000);
      d.setTime(d.getTime() + offset);
    }
    return d;
  });
  candidates.sort((a, b) => a - b);
  // 抖动后可能落到过去，挑第一个仍在未来的
  const future = candidates.find((d) => d > ref);
  return future || candidates[0];
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- API 层 ----------

function buildHeaders(config) {
  return {
    "User-Agent": config.userAgent,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=utf-8",
    token: config.token || "",
  };
}

async function apiCall(config, path, body, method) {
  const url = config.apiBase.replace(/\/$/, "") + path;
  const useGet = method === "GET";
  const res = await fetch(url, {
    method: useGet ? "GET" : "POST",
    headers: buildHeaders(config),
    body: useGet ? undefined : JSON.stringify(body === undefined ? {} : body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口 ${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`);
  }
  if (json.code === 401) {
    const err = new Error("Token 已失效，请重新从 wjiaowu 的 localStorage 复制 Token");
    err.code = 401;
    throw err;
  }
  return json;
}

/** 取当前学期 */
async function fetchSemester(config) {
  const idx = await apiCall(config, "/appapi/Studentpjwj/index", undefined, "GET");
  if (idx.code !== 200) throw new Error(`获取学期失败：${idx.msg || idx.code}`);
  return { xnxqdm: idx.xnxqdm, xnxqmc: idx.xnxqmc || idx.xnxqdm };
}

/** 取随堂评价待评列表 */
async function fetchSessions(config, xnxqdm) {
  const res = await apiCall(config, "/appapi/Studentpjwj/clazz", { xnxqdm });
  if (res.code !== 200) throw new Error(`获取随堂评价列表失败：${res.msg || res.code}`);
  const all = Array.isArray(res.allPjxxList) ? res.allPjxxList : [];
  const pending = all.filter((c) => !c.pjdm && Number(c.passed) === 1);
  return {
    window: res.msg || "",
    allowPj: !!res.allowPj,
    all,
    pending,
    total: all.length,
    done: all.filter((c) => c.pjdm).length,
  };
}

/** 取某个课节的问卷 */
async function fetchSessionForm(config, session) {
  const res = await apiCall(config, "/appapi/Studentpjwj/pjClass", {
    dgksdm: session.dgksdm,
    teadm: session.teadm,
  });
  if (res.code !== 200) throw new Error(`获取问卷失败：${res.msg || res.code}`);
  return res;
}

/** 依据问卷构造 dt / wtpf —— 2 个四星 + 2 个五星（四星位置随机） */
function buildAnswers(config, wtList) {
  const starItems = (wtList || []).filter((i) => String(i.txdm) === "5");
  const fourCount = Math.min(
    Math.max(0, Number(config.fourStarCount ?? 2)),
    Math.max(0, starItems.length - 1)
  );
  const shuffled = shuffle(starItems.map((_, i) => i));
  const fourSet = new Set(shuffled.slice(0, fourCount));

  const dt = [];
  let wtpf = 0;
  let starSeen = 0;

  for (const item of wtList || []) {
    const tx = String(item.txdm);

    if (tx === "5") {
      const selections = item.selections || [];
      if (!selections.length) continue;
      const stars = fourSet.has(starSeen) ? 4 : 5;
      starSeen += 1;
      const sel = selections[Math.min(stars, selections.length) - 1];
      const fz = (Number(item.zbfz) || 0) / selections.length * stars;
      dt.push({
        txdm: item.txdm,
        zbdm: item.zbdm,
        zbmc: item.zbmc,
        zbxmdm: sel.zbxmdm,
        fz,
        dtjg: "★".repeat(stars),
      });
      wtpf += fz;
    } else if (tx === "1") {
      const selections = item.selections || [];
      if (!selections.length) continue;
      // 迟到题固定选「否」
      const want = String(item.zbmc || "").includes("迟到") ? config.lateAnswer || "否" : null;
      const sel = want ? selections.find((s) => s.zbxmmc === want) || selections[0] : selections[0];
      const fz = (Number(sel.fzbl) || 0) * (Number(item.zbfz) || 0) / 100;
      dt.push({
        txdm: item.txdm,
        zbdm: item.zbdm,
        zbmc: item.zbmc,
        zbxmdm: sel.zbxmdm,
        fz,
        dtjg: sel.zbxmmc,
      });
      wtpf += fz;
    } else if (tx === "3") {
      const txt = config.fillSuggestion === false ? "" : config.suggestion;
      const fz = Number(item.zbfz) || 0;
      dt.push({ txdm: item.txdm, zbdm: item.zbdm, zbmc: item.zbmc, fz, dtjg: txt });
      wtpf += fz;
    }
  }

  return { dt, wtpf };
}

/** 提交一个课节的随堂评价（带重试） */
async function submitSession(config, session) {
  const maxAttempts = Math.max(1, Number(config.maxAttempts) || 3);
  const backoff = Math.max(1000, Number(config.retryBackoffMs) || 30000);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await submitSessionOnce(config, session);
    } catch (err) {
      lastErr = err;
      if (err.code === 401) throw err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoff * attempt));
      }
    }
  }
  throw lastErr;
}

async function submitSessionOnce(config, session) {
  const form = await fetchSessionForm(config, session);
  const sk = form.skInfo || {};
  const { dt, wtpf } = buildAnswers(config, form.wtList);
  if (dt.length === 0) throw new Error("问卷没有可作答的题目");

  const payload = {
    pfsm: "",
    dt,
    wtpf,
    wjdm: sk.ktpj || session.ktpj,
    xnxqdm: sk.xnxqdm,
    kcrwdm: sk.kcrwdm || session.kcrwdm,
    teadm: sk.teadm || session.teadm,
    teabh: sk.teabh || "",
    teaxm: sk.teaxm || session.teaxm || "",
    kcptdm: sk.kcptdm || "",
    kcdm: sk.kcdm || session.kcdm || "",
    dgksdm: sk.dgksdm || session.dgksdm,
    jxhjdm: sk.jxhjdm || session.jxhjdm || "",
  };

  const res = await apiCall(config, "/appapi/Studentpjwj/saveClassPj", payload);
  if (res.code !== 200) throw new Error(`提交失败：${res.msg || res.code}`);
  return { pfdm: res.pfdm, wtpf, questions: dt.length };
}

// ---------- 主流程 ----------

async function runEvaluation(config, log) {
  const startedAt = nowIso();
  const details = [];
  const result = {
    ok: false,
    dryRun: !!config.dryRun,
    evaluated: 0,
    pending: 0,
    total: 0,
    message: "",
    startedAt,
    finishedAt: null,
    tokenInvalid: false,
    details,
  };

  try {
    // 浏览器模式允许 Token 为空——它会自动从微信/浏览器 profile 继承。
    // 只有 API 模式必须显式提供 Token。
    if (!config.token && config.mode !== "browser") {
      throw new Error("未配置 Token。请在 wjiaowu.smu.edu.cn 微信登录后，从浏览器 localStorage 复制 Token 填入配置");
    }

    // 浏览器模式：真实点击，指纹最接近真人
    if (config.mode === "browser") {
      const cfg = { ...config };
      // dryRun 必须生效：浏览器模式下用 skipSubmit 实现「只点不提交」
      if (config.dryRun) cfg.skipSubmit = true;
      log("info", `使用浏览器模式（真实点击）${cfg.skipSubmit ? "｜试运行，不提交" : ""}`);
      const r = await runBrowserRun(cfg, log);
      result.ok = !!r.ok;
      result.evaluated = r.evaluated || 0;
      result.pending = r.pending || 0;
      result.message = r.message || "";
      result.tokenInvalid = !!r.tokenInvalid;
      result.details.push(...(r.details || []));
      result.finishedAt = nowIso();
      return result;
    }

    const { xnxqdm, xnxqmc } = await fetchSemester(config);
    const info = await fetchSessions(config, xnxqdm);
    result.total = info.total;
    result.pending = info.pending.length;
    log("info", `学期 ${xnxqmc}，随堂评价共 ${info.total} 条，可评 ${info.pending.length} 条`);

    if (info.pending.length === 0) {
      result.ok = true;
      result.message = `没有待评的课节（共 ${info.total} 条记录，已评 ${info.done} 条）`;
      result.finishedAt = nowIso();
      return result;
    }

    if (config.dryRun) {
      result.ok = true;
      const names = info.pending.map((c) => `${c.jsrq} ${c.kcmc}/${c.teaxm}`);
      result.message = `干跑：可评 ${info.pending.length} 条（${names.join("；")}）`;
      for (const c of info.pending) {
        details.push({ kcmc: c.kcmc, teaxm: c.teaxm, jsrq: c.jsrq, status: "dry-run" });
      }
      result.finishedAt = nowIso();
      return result;
    }

    // 严格串行 + 限量 + 长间隔抖动
    const maxPerRun = Math.max(1, Number(config.maxPerRun) || 10);
    const batch = info.pending.slice(0, maxPerRun);
    const remaining = info.pending.length - batch.length;

    let failed = 0;
    for (let i = 0; i < batch.length; i++) {
      const s = batch[i];
      try {
        const r = await submitSession(config, s);
        result.evaluated += 1;
        details.push({
          kcmc: s.kcmc,
          teaxm: s.teaxm,
          jsrq: s.jsrq,
          status: "ok",
          pfdm: r.pfdm,
          wtpf: r.wtpf,
        });
        log("info", `✅ ${s.jsrq} ${s.kcmc}/${s.teaxm} 已评（${r.wtpf} 分，pfdm=${r.pfdm}）`);
      } catch (err) {
        failed += 1;
        details.push({ kcmc: s.kcmc, teaxm: s.teaxm, jsrq: s.jsrq, status: "failed", error: err.message });
        log("error", `❌ ${s.jsrq} ${s.kcmc}/${s.teaxm} 失败：${err.message}`);
        if (err.code === 401) throw err;
      }

      if (i < batch.length - 1) {
        const base = Math.max(0, Number(config.intervalMs) || 0);
        const jitter = Math.max(0, Number(config.jitterMs) || 0);
        const wait = base + Math.floor(Math.random() * jitter);
        if (wait > 0) {
          log("info", `等待 ${(wait / 1000).toFixed(0)} 秒后继续…`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }

    result.ok = failed === 0;
    result.message = failed === 0
      ? `随堂评价完成：本轮成功 ${result.evaluated} 条${remaining > 0 ? `，剩余 ${remaining} 条待下轮` : "，已全部评完"}`
      : `随堂评价完成：成功 ${result.evaluated} 条，失败 ${failed} 条${remaining > 0 ? `，剩余 ${remaining} 条待下轮` : ""}`;
  } catch (err) {
    result.ok = false;
    result.message = err.message || String(err);
    log("error", result.message);
  }

  result.finishedAt = nowIso();
  return result;
}

// ---------- 默认配置 ----------

const DEFAULTS = {
  enabled: true,
  mode: "browser",
  token: "",
  apiBase: DEFAULT_API_BASE,
  runTimes: DEFAULT_RUN_TIMES,
  fourStarCount: 2,
  lateAnswer: "否",
  suggestion: DEFAULT_SUGGESTION,
  fillSuggestion: true,
  dryRun: true,
  headless: false,
  browserPath: "",
  edgePath: "",
  profileDir: "",
  runJitterMinutes: 30,
  lookbackDays: 1,
  catchUpOnStart: true,
  useRealViewport: true,
  windowSize: "",
  seedProfile: true,
  seedProfileFrom: "",
  readWeChatToken: true,
  suggestionEmptyRate: 0.35,
  varyFourStar: true,
  suggestionFixed: false,
  suggestionPool: [],
  intervalMs: 120000,
  jitterMs: 60000,
  maxPerRun: 10,
  maxAttempts: 3,
  retryBackoffMs: 30000,
  userAgent: "",
};

// ---------- 配置 Schema（DSH 设置界面据此渲染可视化配置窗口）----------

export const Config = z.object({
  enabled: z.boolean().default(true).description("启用自动评课"),
  mode: z
    .string()
    .default("browser")
    .description("运行方式：browser=真实浏览器点击（推荐）；api=直接调接口（快但指纹明显）"),
  token: z
    .string()
    .default("")
    .description("登录 Token，可留空 —— 会自动从电脑版微信或本机浏览器读取"),

  runTimes: z
    .array(z.string())
    .default(["20:30"])
    .description("每天运行时间，格式 HH:MM，可写多个"),
  runJitterMinutes: z
    .number()
    .min(0)
    .max(180)
    .default(30)
    .description("运行时间随机浮动（分钟），避免精准整点"),
  lookbackDays: z
    .number()
    .min(0)
    .max(7)
    .default(1)
    .description("往前补评几天；1 = 今天和昨天一起评"),
  catchUpOnStart: z
    .boolean()
    .default(true)
    .description("错过定时点时，下次启动自动补跑"),

  fourStarCount: z.number().min(0).max(20).default(2).description("四星题目的数量"),
  varyFourStar: z.boolean().default(true).description("四星数量随机浮动（更接近真人）"),

  lateAnswer: z.string().default("否").description("「老师是否迟到」选哪项"),
  dutyAnswer: z.string().default("无职务").description("「你担任的职务」选哪项"),
  requirementAnswer: z
    .string()
    .default("按要求完成了学习")
    .description("「是否达到课程学习要求」选哪项"),
  selfStudyAnswer: z
    .string()
    .default("课程学时30%以内")
    .description("「自主学习比例」选哪项"),

  fillSuggestion: z.boolean().default(true).description("是否填写意见建议"),
  suggestionEmptyRate: z
    .number()
    .min(0)
    .max(1)
    .default(0.35)
    .description("建议留空的概率（0~1），该题本身是选填"),

  dryRun: z.boolean().default(false).description("试运行：只点击不提交"),
  headless: z.boolean().default(false).description("无头模式：不显示浏览器窗口"),
  useRealViewport: z
    .boolean()
    .default(true)
    .description("使用真实窗口与屏幕参数（更接近真人，建议开启）"),
  seedProfile: z
    .boolean()
    .default(true)
    .description("从本机真实浏览器同步历史/书签/Cookie"),
  readWeChatToken: z
    .boolean()
    .default(true)
    .description("从电脑版微信读取 Token（自动续期的主要来源）"),
  browserPath: z
    .string()
    .default("")
    .description("浏览器可执行文件路径，留空则自动探测 Edge / Chrome"),

  intervalMs: z.number().min(0).default(120000).description("课与课之间的间隔（毫秒）"),
  jitterMs: z.number().min(0).default(60000).description("间隔的随机浮动（毫秒）"),
  maxPerRun: z.number().min(1).max(50).default(10).description("每轮最多处理多少条"),
  maxAttempts: z.number().min(1).max(10).default(3).description("失败重试次数"),
  retryBackoffMs: z.number().min(0).default(30000).description("重试退避（毫秒）"),

  // 以下几项属于高级/排障用途，一般不用动
  edgePath: z.string().default("").description("（高级）等同 browserPath，保留兼容"),
  profileDir: z.string().default("").description("（高级）浏览器配置目录，留空自动"),
  seedProfileFrom: z
    .string()
    .default("")
    .description("（高级）从哪个浏览器 profile 同步，留空自动探测"),
  suggestionFixed: z.boolean().default(false).description("（高级）固定使用下面这句建议"),
  suggestion: z.string().default(DEFAULT_SUGGESTION).description("（高级）固定的建议文本"),
  userAgent: z.string().default("").description("（高级）自定义 UA，留空用浏览器真实 UA"),
});

// ---------- 插件入口 ----------

export async function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig };
  const disposers = [];

  let state = { lastRun: null, lastResult: null, runCount: 0, tokenInvalid: false };

  const log = (level, msg) => {
    console.log(`[${PLUGIN}] [${level}] ${msg}`);
  };

  // --- 定时任务 ---
  const doRun = async (reason) => {
    try {
      const result = await runEvaluation(config, log);
      state.runCount += 1;
      state.lastRun = result.startedAt;
      state.lastResult = result;
      state.tokenInvalid = !!result.tokenInvalid;
      const persisted = readPersistedState();
      persisted.lastRunDate = ymd();
      if (result.tokenInvalid) {
        persisted.tokenInvalidAt = nowIso();
      } else {
        persisted.tokenValidatedAt = nowIso();
        persisted.tokenInvalidAt = "";
      }
      writePersistedState(persisted);
      log("info", `${reason}：${result.message}`);
      if (result.tokenInvalid) {
        log("error", "⚠️ TOKEN 已失效，定时任务将持续失败，需要重新提供 Token");
      }
    } catch (err) {
      log("error", `${reason}异常：${err.message}`);
    }
  };

  let scheduleDisposer;
  const scheduleNext = () => {
    if (scheduleDisposer) {
      scheduleDisposer();
      scheduleDisposer = null;
    }
    if (!config.enabled) return;
    const runTimes =
      Array.isArray(config.runTimes) && config.runTimes.length ? config.runTimes : DEFAULT_RUN_TIMES;
    const jitterMinutes = Math.max(0, Number(config.runJitterMinutes) || 0);
    const target = nextRunTime(runTimes, new Date(), jitterMinutes);
    const delay = Math.max(0, target.getTime() - Date.now());
    scheduleDisposer = ctx.timer.timeout(async () => {
      await doRun("定时随堂评价");
      scheduleNext();
    }, delay);
    log("info", `下次定时随堂评价：${target.toLocaleString()}`);
  };
  scheduleNext();

  // --- 开机补跑 ---
  // 场景：定时点（晚上 8 点多）电脑没开，等再开机时当天已经错过。
  // 只要「今天该跑的时间已过」且「今天还没跑过」，启动后延迟几分钟补一次。
  // 因为 lookbackDays 覆盖昨天，补跑时会把漏掉的昨天和今天一起评掉。
  const maybeCatchUp = () => {
    if (config.catchUpOnStart === false || !config.enabled) return;
    const runTimes =
      Array.isArray(config.runTimes) && config.runTimes.length ? config.runTimes : DEFAULT_RUN_TIMES;
    const jitterMs = Math.max(0, Number(config.runJitterMinutes) || 0) * 60000;
    const now = new Date();
    const latestToday = Math.max(
      ...runTimes.map((t) => {
        const { h, m } = parseHhMm(t);
        const d = new Date(now);
        d.setHours(h, m, 0, 0);
        return d.getTime() + jitterMs;
      })
    );
    if (now.getTime() <= latestToday) return; // 今天的点还没到，正常定时会跑
    const persisted = readPersistedState();
    if (persisted.lastRunDate === ymd(now)) return; // 今天已经跑过
    const delay = 60000 + Math.floor(Math.random() * 240000); // 1~5 分钟后补
    log("info", `补跑：今天的定时点已过且今天未运行，${Math.round(delay / 60000)} 分钟后补一次`);
    ctx.timer.timeout(async () => {
      await doRun("开机补跑");
      scheduleNext();
    }, delay);
  };
  maybeCatchUp();

  // --- 工具 ---
  const toolDisposers = [];

  toolDisposers.push(
    ctx.tools.register({
      name: `${TOOL_PREFIX}runNow`,
      description: "立即触发一次南方医科大学教务系统的随堂评价",
      parameters: {
        type: "object",
        properties: {
          dryRun: { type: "boolean", title: "试运行", default: config.dryRun },
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            dryRun: { type: "boolean" },
            evaluated: { type: "number" },
            pending: { type: "number" },
            total: { type: "number" },
            message: { type: "string" },
            startedAt: { type: "string" },
            finishedAt: { type: "string" },
            details: { type: "array" },
          },
        },
        render(_args, value) {
          return [
            {
              type: "text",
              text: `随堂评价：${value.ok ? "✅ 完成" : "❌ 失败"} | 可评 ${value.pending || 0}/${value.total || 0} | 本次评了 ${value.evaluated || 0} 条 | ${value.message}`,
            },
          ];
        },
      },
      async execute(input) {
        const cfg = {
          ...config,
          dryRun: input && input.dryRun !== undefined ? input.dryRun : config.dryRun,
        };
        const result = await runEvaluation(cfg, log);
        state.runCount += 1;
        state.lastRun = result.startedAt;
        state.lastResult = result;
        state.tokenInvalid = !!result.tokenInvalid;
        return {
          ok: !!result.ok,
          dryRun: !!result.dryRun,
          evaluated: result.evaluated || 0,
          pending: result.pending || 0,
          total: result.total || 0,
          message: result.message || "",
          startedAt: result.startedAt || "",
          finishedAt: result.finishedAt || "",
          details: Array.isArray(result.details) ? result.details : [],
        };
      },
    })
  );

  toolDisposers.push(
    ctx.tools.register({
      name: `${TOOL_PREFIX}testConnection`,
      description: "验证 Token 是否有效，并返回当前可评的随堂评价数量",
      parameters: { type: "object", properties: {} },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            code: { type: "number" },
            semester: { type: "string" },
            pending: { type: "number" },
            total: { type: "number" },
            message: { type: "string" },
          },
        },
        render(_args, value) {
          return [
            {
              type: "text",
              text: value.ok
                ? `Token 有效 ✅ | 学期 ${value.semester} | 可评 ${value.pending} 条 / 共 ${value.total} 条`
                : `Token 无效 ❌ | ${value.message}`,
            },
          ];
        },
      },
      async execute() {
        if (!config.token) {
          return { ok: false, code: 0, semester: "", pending: 0, total: 0, message: "未配置 Token" };
        }
        try {
          const { xnxqdm, xnxqmc } = await fetchSemester(config);
          const info = await fetchSessions(config, xnxqdm);
          return {
            ok: true,
            code: 200,
            semester: xnxqmc || "",
            pending: info.pending.length,
            total: info.total,
            message: `可评 ${info.pending.length} 条，已评 ${info.done} 条`,
          };
        } catch (err) {
          return {
            ok: false,
            code: err.code || 0,
            semester: "",
            pending: 0,
            total: 0,
            message: err.message || String(err),
          };
        }
      },
    })
  );

  toolDisposers.push(
    ctx.tools.register({
      name: `${TOOL_PREFIX}getStatus`,
      description: "查看上次运行时间、结果、总运行次数",
      parameters: { type: "object", properties: {} },
      output: {
        schema: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            tokenConfigured: { type: "boolean" },
            tokenInvalid: { type: "boolean" },
            tokenAuto: { type: "boolean" },
            runCount: { type: "number" },
            lastRun: { type: "string" },
            lastResult: { type: "object" },
            nextRunTimes: { type: "array" },
          },
        },
        render(_args, value) {
          const last = value.lastRun ? new Date(value.lastRun).toLocaleString() : "—";
          const r = value.lastResult || {};
          const verdict = r.message ? (r.ok ? "✅" : "❌") + " " + r.message : "—";
          const tokenState = value.tokenInvalid
            ? "⚠️ 已失效，需要重新提供"
            : value.tokenConfigured
              ? "已配置"
              : value.tokenAuto
                ? "自动继承（微信/浏览器）"
                : "未配置";
          const persist = readPersistedState();
          let extra = "";
          if (persist.tokenValidatedAt) {
            extra += ` | Token 最后有效校验：${new Date(persist.tokenValidatedAt).toLocaleString()}`;
          }
          if (persist.tokenInvalidAt) {
            extra += ` | Token 失效于：${new Date(persist.tokenInvalidAt).toLocaleString()}`;
          }
          const alert = value.tokenInvalid
            ? "\n\n⚠️ Token 已失效，定时任务会持续失败。请在【电脑版微信】里打开一次 wjiaowu.smu.edu.cn（手机微信无效），之后插件会自动继承新 Token。"
            : "";
          return [
            {
              type: "text",
              text: `状态：${value.enabled ? "启用" : "停用"} | Token：${tokenState} | 运行 ${value.runCount || 0} 次 | 下次 ${(value.nextRunTimes || []).join(" / ")} | 上次 ${last} | ${verdict}${extra}${alert}`,
            },
          ];
        },
      },
      async execute() {
        return {
          enabled: !!config.enabled,
          tokenConfigured: !!config.token,
          tokenInvalid: !!state.tokenInvalid,
          tokenAuto: config.mode === "browser" && (config.readWeChatToken !== false || config.seedProfile !== false),
          runCount: state.runCount || 0,
          lastRun: state.lastRun || "",
          lastResult: state.lastResult || {},
          nextRunTimes: Array.isArray(config.runTimes) ? config.runTimes : DEFAULT_RUN_TIMES,
        };
      },
    })
  );

  disposers.push(...toolDisposers);

  return () => {
    if (scheduleDisposer) scheduleDisposer();
    for (const d of disposers) {
      if (typeof d === "function") d();
    }
    log("info", "南医大随堂评价助手已卸载");
  };
}
