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

import { runBrowserRun, runCourseRun, collectWeChatTokens } from "./browser.js";
import { ZhjwBrowserClient } from "./tools/zhjw-browser.mjs";
import { ZhjwClient } from "./tools/zhjw-client.mjs";
import z from "@deepseek-ai/schemastery";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 本插件目录（run.cmd 里要写绝对路径给计划任务用）。 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

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

// ---------- 与「计划任务 / 结果回执」共用的数据目录 ----------
//
// 计划任务跑在 DSH 外面，拿不到插件内存里的配置，所以由插件把配置导出成 JSON 快照，
// 再由 CLI（tools/run-once.mjs）读它。反过来，CLI 每次跑完把结果写进 last-run.json，
// DSH 打开时读回来，就能在状态条上显示"上次 ✅ 3 门"——这就是回执。

const DATA_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "smueval-bot"
);
/** 插件导出的配置快照（CLI 只读）。 */
const CONFIG_SNAPSHOT = path.join(DATA_DIR, "config.json");
/** 最近一次运行结果（DSH 与 CLI 都写这里）。 */
const LAST_RUN_FILE = path.join(DATA_DIR, "last-run.json");
/** 历史运行记录，一行一次。 */
const HISTORY_FILE = path.join(DATA_DIR, "runs.jsonl");
/** 计划任务实际调用的批处理，避免 schtasks 的命令行引号地狱。 */
const RUNNER_CMD = path.join(DATA_DIR, "run.cmd");
/** 计划任务模式的输出日志。 */
const RUN_LOG = path.join(DATA_DIR, "run.log");
/** 计划任务名前缀；每个运行时间一个任务，例如 smueval-bot-2030。 */
const TASK_PREFIX = "smueval-bot";

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
  return DATA_DIR;
}

function readLastRun() {
  try {
    return JSON.parse(fs.readFileSync(LAST_RUN_FILE, "utf8")) || null;
  } catch {
    return null;
  }
}

/** 记一次运行结果：DSH 内跑的、计划任务跑的，都写到同一份回执里。 */
function recordRun(result, source) {
  if (result === null || typeof result !== "object") return;
  ensureDataDir();
  const record = {
    ok: !!result.ok,
    dryRun: !!result.dryRun,
    evaluated: result.evaluated || 0,
    pending: result.pending || 0,
    message: result.message || "",
    tokenInvalid: !!result.tokenInvalid,
    startedAt: result.startedAt || nowIso(),
    finishedAt: result.finishedAt || nowIso(),
    source: source || "dsh",
    details: Array.isArray(result.details) ? result.details.slice(0, 50) : [],
  };
  try {
    fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(record, null, 2), "utf8");
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch {}
}

/** 把当前配置导出给 CLI；顺带记下已注册的计划任务名，便于下次清理。 */
function exportConfigSnapshot(config, systemTask) {
  ensureDataDir();
  const snapshot = {
    ...config,
    __meta: {
      exportedAt: nowIso(),
      pluginDir: PLUGIN_DIR,
      nodePath: process.execPath,
      systemTasks: systemTask && Array.isArray(systemTask.tasks) ? systemTask.tasks : [],
    },
  };
  try {
    fs.writeFileSync(CONFIG_SNAPSHOT, JSON.stringify(snapshot, null, 2), "utf8");
  } catch {}
}

// ---------- Windows 计划任务 ----------

function hhmmToTaskName(hhmm) {
  return `${TASK_PREFIX}-${String(hhmm).replace(/[^0-9]/g, "").padEnd(4, "0").slice(0, 4)}`;
}

function schtasks(args) {
  return execFileSync("schtasks", args, {
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let cachedNodePath;
/**
 * 找真正的 node 可执行文件。
 *
 * 关键坑：DSH 桌面端是 Electron，process.execPath 指向的是「DeepSeek Harness.exe」，
 * 拿它去跑 .mjs 只会把应用再启动一次。所以这里优先用 DSH 自带的运行时 node。
 */
function findNodeExecutable() {
  if (cachedNodePath !== undefined) return cachedNodePath;
  const candidates = [];
  const inElectron = !!(process.versions && process.versions.electron);
  if (!inElectron) candidates.push(process.execPath);
  for (const key of ["DSH_NODE", "DSH_NODE_PATH", "NODE_EXTERNAL"]) {
    const value = process.env[key];
    if (typeof value === "string" && value !== "") candidates.push(value);
  }
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const runtimes = path.join(dshHome, "dsh-runtimes");
  try {
    const entries = fs.readdirSync(runtimes, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      candidates.push(path.join(runtimes, entry.name, "dependencies", "node", "bin", "node.exe"));
    }
  } catch {}
  candidates.push(path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"));
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cachedNodePath = candidate;
        return cachedNodePath;
      }
    } catch {}
  }
  try {
    const found = execFileSync("where", ["node"], { windowsHide: true, encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");
    if (found) {
      cachedNodePath = found;
      return cachedNodePath;
    }
  } catch {}
  throw new Error("找不到 node.exe（计划任务需要它；可设置环境变量 DSH_NODE 指向 node.exe）");
}

/** 生成 run.cmd：把 node、脚本、日志重定向都写死在文件里，计划任务只调它。 */
function writeRunnerCmd() {
  ensureDataDir();
  const nodePath = findNodeExecutable();
  // 统一走 dispatch.mjs：它运行时读当前 channel 再分派（wjiaowu / zhjw / auto），
  // 所以用户在配置面板改了「评课途径」不需要重新注册计划任务，下次触发自动生效。
  const script = path.join(PLUGIN_DIR, "tools", "dispatch.mjs");
  const body = [
    "@echo off",
    "chcp 65001 >nul",
    `echo ==== %DATE% %TIME% ==== >> "${RUN_LOG}"`,
    `"${nodePath}" "${script}" --jitter >> "${RUN_LOG}" 2>&1`,
    "",
  ].join("\r\n");
  fs.writeFileSync(RUNNER_CMD, body, "utf8");
  return { runner: RUNNER_CMD, script, nodePath };
}

/**
 * 让系统计划任务与配置保持一致：systemTask=true 时按 runTimes 建/更新任务，
 * false 时把上次登记的（以及按当前 runTimes 能推出来的）任务删掉。
 * 全程不抛异常：DSH 装不了计划任务不该影响评课本身。
 */
function syncSystemTasks(config, log) {
  const wanted = Array.isArray(config.runTimes) ? config.runTimes : DEFAULT_RUN_TIMES;
  let known = [];
  try {
    const snapshot = JSON.parse(fs.readFileSync(CONFIG_SNAPSHOT, "utf8"));
    if (snapshot && snapshot.__meta && Array.isArray(snapshot.__meta.systemTasks)) {
      known = snapshot.__meta.systemTasks;
    }
  } catch {}
  const state = { enabled: !!config.systemTask, tasks: [], error: "" };

  // 关联：插件已禁用时，强制关闭 Windows 计划任务注册（避免孤儿任务触发后找不到 DSH 服务）
  if (!config.enabled && config.systemTask) {
    log("info", "插件已禁用，自动关闭 Windows 计划任务注册");
    config.systemTask = false;
  }

  if (!config.systemTask) {
    const toDelete = new Set([...known, ...wanted.map(hhmmToTaskName)]);
    for (const name of toDelete) {
      try {
        schtasks(["/Delete", "/F", "/TN", name]);
        log("info", `已删除计划任务 ${name}`);
      } catch {
        // 本来就不存在：忽略
      }
    }
    return state;
  }

  try {
    writeRunnerCmd();
  } catch (err) {
    state.error = `写 run.cmd 失败：${err && err.message ? err.message : err}`;
    return state;
  }

  const names = [];
  for (const hhmm of wanted) {
    const name = hhmmToTaskName(hhmm);
    try {
      schtasks(["/Create", "/F", "/SC", "DAILY", "/ST", String(hhmm), "/TN", name, "/TR", `"${RUNNER_CMD}"`]);
      names.push(name);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      state.error = `创建 ${name} 失败：${message}`;
      log("warn", state.error);
    }
  }
  state.tasks = names;

  // 去掉不再需要的老任务（比如改了运行时间）
  for (const stale of known) {
    if (names.includes(stale)) continue;
    try {
      schtasks(["/Delete", "/F", "/TN", stale]);
      log("info", `已清理过期计划任务 ${stale}`);
    } catch {}
  }
  return state;
}


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

/** 掩码展示 Token：够辨认、又不至于被复制走。 */
function maskToken(token) {
  const t = String(token || "");
  if (t.length <= 10) return t === "" ? "(空)" : t.slice(0, 4) + "…";
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

/** 把微信窗口切到前台（Qt 窗口没有可定位控件，只能靠系统级窗口操作）。 */
function focusWeChatWindow() {
  const dir = ensureDataDir();
  const scriptPath = path.join(dir, "focus-wechat.ps1");
  const script = [
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class WxFocus {",
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);',
    "}",
    '"@',
    '$h = [WxFocus]::FindWindow("Qt51514QWindowIcon", "微信")',
    "if ($h -eq [IntPtr]::Zero) { $h = [WxFocus]::FindWindow($null, \"微信\") }",
    "if ($h -eq [IntPtr]::Zero) { Write-Output 'NOTFOUND'; exit 1 }",
    "# 先按一下 Alt，解除前台锁定限制，SetForegroundWindow 才生效",
    "[WxFocus]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)",
    "[WxFocus]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)",
    "[WxFocus]::ShowWindow($h, 9) | Out-Null",
    "[WxFocus]::SetForegroundWindow($h) | Out-Null",
    "Write-Output 'OK'",
    "exit 0",
  ].join("\r\n");
  try {
    fs.writeFileSync(scriptPath, script, "utf8");
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { encoding: "utf8", timeout: 15000, windowsHide: true }
    );
    return { ok: String(out).includes("OK"), output: String(out).trim() };
  } catch (err) {
    const out = String((err && err.stdout) || "").trim();
    return { ok: out.includes("OK"), output: out || String((err && err.message) || err) };
  }
}

/**
 * 校验一个 Token 是否还有效：直接打 getIstoken（GET，header 带 token）。
 * 不启浏览器，几百毫秒就有结果，可以放心在面板里反复点。
 */
async function validateTokenDetailed(apiBase, token) {
  if (!token) return { valid: false, code: 0, message: "空 Token" };
  const base = String(apiBase || DEFAULT_API_BASE).replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/appapi/getIstoken`, {
      method: "GET",
      headers: {
        token: String(token),
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (json === null) {
      return { valid: false, code: res.status, message: `接口返回非 JSON（HTTP ${res.status}）` };
    }
    return { valid: json.code === 200, code: json.code, message: String(json.msg || "") };
  } catch (err) {
    return { valid: false, code: -1, message: String(err && err.message ? err.message : err) };
  }
}

/**
 * 扫一遍所有能拿到的 Token 来源并逐个校验。
 * 这是「在微信里点一下链接 → 插件自动继承」的可用替代：
 * 微信端没法被程序驱动去开网址（见 README），但可以持续盯着它的本地存储。
 */
async function scanTokenSources(config, log, opts = {}) {
  const apiBase = config.apiBase || DEFAULT_API_BASE;
  const candidates = [];
  const stopOnValid = opts.stopOnValid === true;

  let wechat = [];
  try {
    wechat = collectWeChatTokens(log) || [];
  } catch (err) {
    log("warn", `扫描微信存储失败：${err.message}`);
    wechat = [];
  }
  // 离 wjiaowu 越近越可能有效，最多验 8 个，够快也够准
  for (const token of wechat.slice(0, 8)) {
    const v = await validateTokenDetailed(apiBase, token);
    candidates.push({
      source: "wechat",
      masked: maskToken(token),
      token,
      valid: v.valid,
      code: v.code,
      message: v.message,
    });
    if (stopOnValid && v.valid) break;
  }

  const configToken = String(config.token || "");
  if (configToken !== "" && !(stopOnValid && candidates.some((c) => c.valid))) {
    const v = await validateTokenDetailed(apiBase, configToken);
    candidates.push({
      source: "config",
      masked: maskToken(configToken),
      token: configToken,
      valid: v.valid,
      code: v.code,
      message: v.message,
    });
  }

  const best = candidates.find((item) => item.valid) || null;
  return {
    candidates,
    wechatCount: wechat.length,
    configToken: configToken !== "",
    best: best === null ? null : { source: best.source, masked: best.masked, token: best.token },
    checkedAt: nowIso(),
  };
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
      // 判断题一律选否定项：「教师上课迟到5分钟以上」「教师宣传错误价值理念」
      // 这类题选「是」等于给老师打差评，真实评价里永远是「否」。
      // 迟到题仍然优先用配置里的 lateAnswer。
      const isLate = String(item.zbmc || "").includes("迟到");
      const preferred = isLate ? String(config.lateAnswer || "否") : "否";
      const negatives = ["否", "没有", "无", "不存在", "未"];
      const sel =
        selections.find((s) => String(s.zbxmmc || "").trim() === preferred) ||
        selections.find((s) => negatives.includes(String(s.zbxmmc || "").trim())) ||
        selections.find((s) => negatives.some((word) => String(s.zbxmmc || "").includes(word))) ||
        selections[selections.length - 1];
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

async function runEvaluationInner(config, log) {
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
  // 期末评课程一次最多处理多少门（只在手动点按钮时用）
  courseMaxPerRun: 20,
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
  varyFourStar: false,
  suggestionFixed: false,
  suggestionPool: [],
  intervalMs: 120000,
  jitterMs: 60000,
  maxPerRun: 10,
  maxAttempts: 3,
  retryBackoffMs: 30000,
  userAgent: "",
  /** 是否在会话输入框下方显示状态条。 */
  showStatusBar: true,
  /** 是否注册 Windows 计划任务（DSH 不开也能跑）。 */
  systemTask: false,

  // ---------- zhjw.smu.edu.cn 渠道（账号密码 + ONNX 验证码） ----------
  channel: "wjiaowu",        // "wjiaowu" | "zhjw" | "auto"
  zhjwAccount: "",           // 统一身份认证账号
  zhjwPassword: "",          // 统一身份认证密码（本地存储，Base64 编码，非加密）
  zhjwEnabled: false,        // 是否启用 zhjw 渠道（由 channel 自动派生：zhjw/auto 为 true）
  zhjwMode: "browser",       // "browser"（浏览器键鼠模拟，推荐）| "http"（纯 HTTP）
  zhjwMaxAttempts: 3,        // 单次运行最大尝试次数（含验证码失败重试）
  zhjwRetryDelayMinutes: 15, // 验证码/登录失败后重试间隔（分钟）
};

// ---------- 配置端点（给插件页的配置面板读写用）----------
//
// 为什么不走 DSH 的 settings 面板：面板只投影 Config 里标了 .volatile() 的字段，
// 而 volatile 值在运行时会变成 cosmokit 的 Volatile 引用（对象里带函数），
// 一旦被结构化克隆就抛 "() => current could not be cloned"，会把整轮对话弄挂。
// 所以本插件自己开一条回环 HTTP 端点，面板直连它读写配置。

/** 本插件配置端点的路径前缀。 */
const WEB_ROUTE = "/api/smueval-bot";
/** 已注册过该路径的实例（Loader 重放/多实例时避免重复注册）。 */
const ROUTE_OWNED = new Set();
/** 只信任本机回环。 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** 本插件的 loader 条目 id（cordis.patch.yml 里 insert 的 id）。 */
const ENTRY_ID = PLUGIN;

/**
 * 读自己的包名：面板挂点是按安装时的包名派发的，发布成别的名字时不能写死。
 * 读不到就退回默认名，不影响本机使用。
 */
function readPackageName() {
  try {
    const file = new URL("./package.json", import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed.name === "string" && parsed.name !== "") return parsed.name;
  } catch {
    // 打包/压缩环境下读不到就用默认值
  }
  return "@local/smueval-bot";
}

const PACKAGE_NAME = readPackageName();

/** 在配置条目里找本插件那一行：先按 id，再按包名兜底（不同 DSH 版本 entries() 的形状可能不同）。 */
function findOwnEntry(editor) {
  const rows = editor.entries();
  const byId = rows.find((row) => row?.options?.id === ENTRY_ID);
  if (byId !== undefined) return byId;
  const wanted = [PACKAGE_NAME, PACKAGE_NAME.split("/").pop()].filter(Boolean);
  return rows.find((row) => {
    const name = String(row?.options?.name ?? "");
    return wanted.some((candidate) => name === candidate) || name.endsWith("/" + ENTRY_ID);
  });
}


function sendJson(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 从 Host 头取主机名：同时支持 example.com:3080 与 [::1]:3080。 */
function hostNameOf(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    return close >= 0 ? raw.slice(0, close + 1) : raw;
  }
  const colon = raw.lastIndexOf(":");
  return colon >= 0 && /^\d+$/.test(raw.slice(colon + 1)) ? raw.slice(0, colon) : raw;
}

/** 同源闸：挡 DNS rebinding 与跨站写；桌面壳层同源 fetch 不带 Origin，按 sec-fetch-site 判。 */
function sameOriginBlocked(req) {
  const peer = String(req.socket?.remoteAddress || "");
  if (peer && !/^(::1|::ffff:127\.|127\.)/.test(peer)) {
    return `非本机请求被拒绝（对端地址 ${peer} 不是回环）`;
  }
  const host = hostNameOf(req.headers?.host);
  if (!LOOPBACK.has(host)) return "非本机请求被拒绝（Host 必须是回环地址）";
  const method = String(req.method || "GET").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD";
  const origin = req.headers?.origin;
  const site = req.headers?.["sec-fetch-site"];
  if (mutating && !origin) {
    if (site === "cross-site" || site === "same-site") {
      return `跨站写请求被拒绝（缺少 Origin 且 sec-fetch-site=${site}）`;
    }
  }
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return "非法 Origin 头";
    }
    if (originHost !== host && !(LOOPBACK.has(host) && LOOPBACK.has(originHost))) return "跨源访问被拒绝";
  }
  if (mutating) {
    const ct = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (ct !== "application/json") {
      return `跨站写请求被拒绝（Content-Type 必须是 application/json，收到：${ct || "无"}）`;
    }
  }
  if (site && site !== "same-origin" && site !== "none") return `跨站请求被拒绝（sec-fetch-site=${site}）`;
  return null;
}

/** 读小 JSON body；读不到就给 {}。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 65536) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/** 面板可读的配置视图：Token 不回明文，只报「是否已配置」。 */
function publicConfig(config) {
  const view = { ...config };
  view.tokenConfigured = typeof config.token === "string" && config.token.trim() !== "";
  view.token = "";
  return view;
}

/** 按默认值类型收窄一份补丁，只保留认识的字，防止面板写进奇怪的形状。 */
function sanitizePatch(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
    const like = DEFAULTS[key];
    if (Array.isArray(like)) {
      if (!Array.isArray(value)) continue;
      out[key] = value.map((item) => String(item)).filter((item) => item !== "").slice(0, 12);
      continue;
    }
    if (typeof like === "boolean") {
      out[key] = value === true || value === "true";
      continue;
    }
    if (typeof like === "number") {
      const num = Number(value);
      if (Number.isFinite(num)) out[key] = num;
      continue;
    }
    if (typeof value === "string") out[key] = value.slice(0, 4096);
  }
  return out;
}



// ---------- 配置 Schema（DSH 据此投影设置文档；本插件的编辑走上面的自建端点）----------

// 注意：不要给这些字段加 .volatile()。
// DSH 的设置面板只投影 volatile 字段，但 volatile 字段在运行时会被包装成
// cosmokit 的 Volatile 引用（对象里带函数），一旦被结构化克隆就会抛
// "() => current could not be cloned"，把整轮对话弄挂。所以本插件改配置走
// cordis.patch.yml，不在设置面板里编辑。
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
  varyFourStar: z.boolean().default(false).description("四星数量是否随机浮动；关掉就固定为 fourStarCount 个"),

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

  // 界面
  showStatusBar: z
    .boolean()
    .default(true)
    .description("在会话输入框下方显示状态条（南医大评课助手 · 每天 20:30）"),
  systemTask: z
    .boolean()
    .default(false)
    .description("注册 Windows 计划任务：即使没打开 DSH，也会按上面的运行时间自动评课（仅 browser 模式）"),

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

/** 跑一轮并把结果写进回执：DSH 内触发的和计划任务触发的共用同一份 last-run.json。 */
async function runEvaluation(config, log, source = "dsh") {
  const result = await runEvaluationInner(config, log);
  try {
    recordRun(result, source);
  } catch {
    // 回执写不出去不影响评课
  }
  return result;
}
// ---------- 插件入口 ----------

export async function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig };
  // zhjwEnabled 由 channel 派生：选 zhjw 或 auto 即启用 zhjw 渠道，不再单独暴露复选框
  config.zhjwEnabled = config.channel === "zhjw" || config.channel === "auto";
  const disposers = [];

  let state = { lastRun: null, lastResult: null, runCount: 0, tokenInvalid: false, running: false, scanning: false, refreshingToken: false };

  const log = (level, msg) => {
    console.log(`[${PLUGIN}] [${level}] ${msg}`);
  };

  // 让系统计划任务跟上配置（配置变更时由 syncSystemTasks 处理；插件禁用时由 dispose 钩子清理）
  let systemTaskState = { enabled: !!config.systemTask, tasks: [], error: "" };
  try {
    systemTaskState = syncSystemTasks(config, log);
  } catch (err) {
    systemTaskState = {
      enabled: !!config.systemTask,
      tasks: [],
      error: String(err && err.message ? err.message : err),
    };
    log("warn", `计划任务同步失败：${systemTaskState.error}`);
  }
  if (systemTaskState.error) log("warn", `计划任务：${systemTaskState.error}`);
  try {
    exportConfigSnapshot(config, systemTaskState);
  } catch {
    // 快照写不出去只影响脱离 DSH 的模式
  }

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
    // 交给 Windows 计划任务时不在这里排期：否则同一天会被两套定时各跑一遍。
    if (config.systemTask) {
      log("info", "已启用 Windows 计划任务，DSH 内定时器让位（避免同一天跑两遍）");
      return;
    }
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

  /**
   * 把 Token 写进配置（走 configEditor，和面板保存是同一条路）。
   * 写入会触发插件重载，所以调用方之后就不要再假设自己还活着。
   */
  const writeTokenToConfig = async (token) => {
    const editor = ctx.get("configEditor");
    if (editor === undefined) return false;
    const entry = findOwnEntry(editor);
    if (entry === undefined) return false;
    await editor.edit(entry, (current) => ({ ...current, token }));
    return true;
  };

  // ---- Token 失效后的自动监听 ----
  // 微信没法被程序驱动去开网页（Qt 窗口无控件、无调试端口），
  // 所以退一步：跑挂时自动盯住微信的本地存储，你只要在微信里点一次链接，这边直接接管。
  const tokenWatch = { timer: null, until: 0, minutes: 0 };
  const stopTokenWatch = () => {
    if (tokenWatch.timer !== null) {
      clearInterval(tokenWatch.timer);
      tokenWatch.timer = null;
    }
    tokenWatch.until = 0;
  };
  disposers.push(stopTokenWatch);

  const startTokenWatch = (minutes) => {
    if (tokenWatch.timer !== null) return;
    const mins = Math.max(1, Math.min(60, Number(minutes) || 10));
    tokenWatch.minutes = mins;
    tokenWatch.until = Date.now() + mins * 60000;
    log("info", `Token 已失效 → 开始监听微信 ${mins} 分钟：在电脑版微信里点开链接登录一次，这边会自动写入新 Token`);
    tokenWatch.timer = setInterval(async () => {
      if (Date.now() > tokenWatch.until) {
        stopTokenWatch();
        log("warn", "监听结束：微信里始终没抓到有效 Token");
        return;
      }
      try {
        const scanned = await scanTokenSources(config, log, { stopOnValid: true });
        const hit = scanned.best;
        if (hit && hit.token && hit.token !== config.token) {
          stopTokenWatch();
          log("info", `抓到有效 Token（${hit.source === "wechat" ? "微信端" : "配置里"}）${hit.masked}，正在写入配置…`);
          const written = await writeTokenToConfig(hit.token);
          if (!written) log("warn", "没能写进配置（没有 configEditor），请到面板里点「用这个」");
        }
      } catch (err) {
        log("warn", `监听扫描失败：${err && err.message ? err.message : err}`);
      }
    }, 20000);
    if (typeof tokenWatch.timer.unref === "function") tokenWatch.timer.unref();
  };

  /**
   * 跑一次微信浮窗刷新脚本（tools/wechat-token.ps1）。
   * 脚本负责：唤醒微信（没开就启动并等扫码）→ 点手机图标 → OCR 找到「教学服务平台系统」
   * → 点它 → 等内置浏览器把 OAuth 走完 → 关掉浏览器窗口。
   */
  const analyzeScriptOutput = (text) => {
    const line = String(text || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => item.startsWith("{") && item.endsWith("}"))
      .pop();
    if (!line) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  };

  // 用异步 execFile：这个脚本要开关微信窗口、跑 OCR，几十秒很正常，
  // 用 execFileSync 会把整个 DSH 的事件循环卡住。
  const execFileAsync = (file, args, options) =>
    new Promise((resolve) => {
      execFile(file, args, options, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    });

  const runWeChatTokenScript = async () => {
    const script = path.join(PLUGIN_DIR, "tools", "wechat-token.ps1");
    if (!fs.existsSync(script)) return { ok: false, error: "缺少 tools/wechat-token.ps1" };
    const { err, stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script],
      { encoding: "utf8", timeout: 300000, windowsHide: true }
    );
    const parsed = analyzeScriptOutput(stdout);
    if (parsed) return parsed;
    if (err) return { ok: false, error: String((err && err.message) || err) };
    return { ok: false, error: "脚本没有输出可解析的 JSON" };
  };

  /**
   * 用微信浮窗刷新 Token。
   * persist=true 时把新 Token 写回配置（会触发插件重载，所以评课进行中不要写）。
   */
  const refreshTokenViaWeChat = async (opts = {}) => {
    if (state.refreshingToken) return { ok: false, error: "正在刷新 Token，等它跑完" };
    state.refreshingToken = true;
    try {
      log("info", "开始用微信浮窗刷新 Token…");
      const scripted = await runWeChatTokenScript();
      if (!scripted.ok) {
        log("warn", `微信刷新失败：${scripted.error || "未知原因"}`);
        return { ok: false, error: scripted.error || "脚本执行失败", script: scripted };
      }
      await new Promise((resolve) => setTimeout(resolve, 1500)); // 等 leveldb 落盘
      const scanned = await scanTokenSources(config, log, { stopOnValid: true });
      const hit = scanned.best;
      if (!hit) return { ok: false, error: "页面打开了，但没扫到有效 Token", script: scripted };
      const changed = hit.token !== config.token;
      if (changed) config.token = hit.token; // 先在本实例里生效，评课可立刻用
      let persisted = false;
      if (opts.persist === true && changed) persisted = await writeTokenToConfig(hit.token);
      log(
        "info",
        `微信刷新成功：${hit.masked}${changed ? "（新 Token）" : "（与配置相同）"}${persisted ? "，已写入配置" : ""}`
      );
      return { ok: true, masked: hit.masked, changed, persisted, script: scripted };
    } finally {
      state.refreshingToken = false;
    }
  };

  /**
   * 期末「评课程」：只在面板手动点按钮时跑，不进每日自动流程。
   * 和 runOnce 共用 running 互斥锁，避免两个浏览器撞 profile。
   */
  const runCourseOnce = async (dryRun) => {
    if (state.running) {
      return {
        ok: false,
        evaluated: 0,
        pending: 0,
        message: "已有评课任务在进行，等它结束再试",
        details: [],
        busy: true,
      };
    }
    state.running = true;
    try {
      const cfg = { ...config, dryRun: dryRun === true, skipSubmit: dryRun === true || config.skipSubmit };
      log("info", `开始评课程（${cfg.skipSubmit ? "试运行，不提交" : "正式提交"}）`);
      const result = await runCourseRun(cfg, log);
      state.lastCourseRun = nowIso();
      state.lastCourseResult = result;
      if (result.tokenInvalid) startTokenWatch(10);
      return result;
    } finally {
      state.running = false;
    }
  };
  /**
   * 跑一轮，供「工具 / 配置面板的立即执行 / HTTP 端点」共用。
   * 同一时间只允许跑一次：两个浏览器自动化并发会互相抢 profile 和页面焦点。
   */
  const runOnce = async (dryRun) => {
    if (state.running) {
      return {
        ok: false,
        dryRun: !!dryRun,
        evaluated: 0,
        pending: 0,
        total: 0,
        message: "已有一次评课正在进行，等它结束再试",
        startedAt: nowIso(),
        finishedAt: nowIso(),
        details: [],
        busy: true,
      };
    }
    state.running = true;
    try {
      const cfg = { ...config, dryRun: dryRun === undefined || dryRun === null ? config.dryRun : !!dryRun };
      let result = await runEvaluation(cfg, log);
      // Token 失效 → 先用微信浮窗自动换新 Token（不写配置，避免中途重载打断），再补跑一次
      if (result.tokenInvalid && dryRun !== true) {
        log("warn", "Token 失效，尝试用微信浮窗自动刷新…");
        const refreshed = await refreshTokenViaWeChat({ persist: false });
        if (refreshed.ok) {
          result = await runEvaluation({ ...config, dryRun: cfg.dryRun }, log);
          // 评课跑完再把新 Token 落盘（这时重载不会打断任何东西）
          if (refreshed.changed) await writeTokenToConfig(config.token);
        } else {
          startTokenWatch(10);
        }
      }
      state.runCount += 1;
      state.lastRun = result.startedAt;
      state.lastResult = result;
      state.tokenInvalid = !!result.tokenInvalid;
      if (result.tokenInvalid) startTokenWatch(10);
      return result;
    } finally {
      state.running = false;
    }
  };

  // --- 开机补跑 ---
  // 场景：定时点（晚上 8 点多）电脑没开，等再开机时当天已经错过。
  // 只要「今天该跑的时间已过」且「今天还没跑过」，启动后延迟几分钟补一次。
  // 因为 lookbackDays 覆盖昨天，补跑时会把漏掉的昨天和今天一起评掉。
  const maybeCatchUp = () => {
    if (config.catchUpOnStart === false || !config.enabled) return;
    // 计划任务模式下补跑也由系统那边负责（它错过会自己在下次登录后跑），这里不重复。
    if (config.systemTask) return;
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
        const result = await runOnce(input && input.dryRun !== undefined ? input.dryRun : config.dryRun);
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

  // --- 配置端点：插件页的配置面板读写这里 ---
  ctx.inject(["webServer"], (child) => {
    if (ROUTE_OWNED.has(WEB_ROUTE)) return;
    ROUTE_OWNED.add(WEB_ROUTE);
    disposers.push(() => ROUTE_OWNED.delete(WEB_ROUTE));
    disposers.push(
      child.webServer.register({
        kind: "prefix",
        path: WEB_ROUTE,
        handler: async (req, res) => {
          const blocked = sameOriginBlocked(req);
          if (blocked) return sendJson(res, 403, { ok: false, error: blocked });
          let url;
          try {
            url = new URL(req.url, "http://127.0.0.1");
          } catch {
            return sendJson(res, 400, { ok: false, error: "非法请求地址" });
          }

          if (req.method === "GET" && url.pathname === `${WEB_ROUTE}/config`) {
            const editor = ctx.get("configEditor");
            let patchPath = "";
            try {
              patchPath = editor === undefined ? "" : String(editor.documentPath ?? "");
            } catch {
              patchPath = "";
            }
            return sendJson(res, 200, {
              ok: true,
              data: {
                config: publicConfig(config),
                defaults: publicConfig({ ...DEFAULTS, token: "" }),
                entryId: ENTRY_ID,
                packageName: PACKAGE_NAME,
                patchPath,
                writable: editor !== undefined,
                state: (() => {
                  // 回执可能由计划任务写入（它跑在 DSH 外面），也可能是我这边刚跑的，
                  // 谁的时间更新就显示谁。
                  const persisted = readLastRun();
                  const memory = state.lastResult && state.lastResult.finishedAt ? state.lastResult.finishedAt : "";
                  const useFile = persisted !== null &&
                    persisted !== undefined &&
                    (memory === "" || Date.parse(String(persisted.finishedAt || persisted.startedAt || "")) >= Date.parse(memory));
                  const last = useFile ? persisted : null;
                  return {
                    runCount: state.runCount || 0,
                    running: !!state.running,
                    lastRun: (last && (last.finishedAt || last.startedAt)) || state.lastRun || "",
                    lastResult: last || state.lastResult || {},
                    lastSource: (last && last.source) || (state.lastResult ? "dsh" : ""),
                    tokenInvalid: last ? !!last.tokenInvalid : !!state.tokenInvalid,
                    systemTask: systemTaskState,
                    tokenWatch:
                      tokenWatch.timer === null
                        ? { active: false, secondsLeft: 0 }
                        : {
                            active: true,
                            secondsLeft: Math.max(0, Math.round((tokenWatch.until - Date.now()) / 1000)),
                          },
                  };
                })(),
              },
            });
          }

          // 期末评课程：面板上的「评价课程」按钮调这里，平时自动流程不会碰它。
          if (req.method === "POST" && url.pathname === `${WEB_ROUTE}/course/evaluate`) {
            if (state.running) {
              return sendJson(res, 409, { ok: false, error: "已有任务在跑，等它结束" });
            }
            const body = await readJsonBody(req);
            const dryRun = body && body.dryRun === true;
            const result = await runCourseOnce(dryRun);
            return sendJson(res, result.ok ? 200 : 500, {
              ok: !!result.ok,
              data: {
                ok: !!result.ok,
                evaluated: result.evaluated || 0,
                pending: result.pending || 0,
                message: result.message || "",
                details: Array.isArray(result.details) ? result.details : [],
              },
              error: result.ok ? undefined : result.message,
            });
          }
          // 用微信浮窗刷新 Token：面板「刷新 Token」按钮调这里。
          if (req.method === "POST" && url.pathname === `${WEB_ROUTE}/token/refresh-wechat`) {
            if (state.running) {
              return sendJson(res, 409, { ok: false, error: "正在评课，等它结束再刷新 Token" });
            }
            const result = await refreshTokenViaWeChat({ persist: true });
            return sendJson(res, result.ok ? 200 : 502, { ok: result.ok, data: result, error: result.ok ? undefined : result.error });
          }

          // 扫描所有 Token 来源并校验：面板「扫描 Token / 监听微信」调这里。
          if (req.method === "POST" && url.pathname === `${WEB_ROUTE}/token/scan`) {
            if (state.scanning) {
              return sendJson(res, 409, { ok: false, error: "正在扫描，稍等" });
            }
            state.scanning = true;
            try {
              const data = await scanTokenSources(config, log);
              return sendJson(res, 200, { ok: true, data });
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: `扫描失败：${err.message}` });
            } finally {
              state.scanning = false;
            }
          }

          // 立即执行：面板上的「立即执行 / 试运行」按钮调这里。
          // 根据 config.channel 分派：zhjw 渠道走 run-zhjw.mjs（或内置 ZhjwBrowserClient），wjiaowu/auto 走 runOnce。
          // 评课要真的开浏览器点页面，可能几十秒，所以先回 started，客户端自己轮询 running。
          if (req.method === "POST" && url.pathname === `${WEB_ROUTE}/run`) {
            if (state.running) {
              return sendJson(res, 409, { ok: false, error: "已有一次评课正在进行，等它结束再试" });
            }
            const body = await readJsonBody(req);
            const dryRun = body && body.dryRun === true;
            const channel = String(config.channel || "wjiaowu");

            if (channel === "zhjw") {
              if (!config.zhjwEnabled) {
                return sendJson(res, 400, { ok: false, error: "zhjw 渠道未启用，请先在设置中打开「启用 zhjw 渠道」" });
              }
              if (!config.zhjwAccount || !config.zhjwPassword) {
                return sendJson(res, 400, { ok: false, error: "zhjw 账号或密码未配置，请在设置中填写统一身份认证账号密码" });
              }
              sendJson(res, 200, { ok: true, data: { started: true, dryRun, channel: "zhjw" } });
              const zhjwLog = (level, msg) => {
                log(level, `[zhjw] ${msg}`);
                try {
                  ensureDataDir();
                  fs.appendFileSync(
                    RUN_LOG,
                    `[${new Date().toISOString()}] [${level}] [zhjw] ${msg}\n`,
                    "utf8"
                  );
                } catch {}
              };
              Promise.resolve()
                .then(() => {
                  // 默认用浏览器键鼠模拟（更真实）；body.http=true 可切回纯 HTTP 模式
                  const useHttp = body && body.http === true;
                  const ClientClass = useHttp ? ZhjwClient : ZhjwBrowserClient;
                  zhjwLog("info", `模式：${useHttp ? "纯 HTTP" : "浏览器键鼠模拟"}`);
                  const client = new ClientClass({
                    account: config.zhjwAccount,
                    password: config.zhjwPassword,
                    log: zhjwLog,
                    config: config,
                  });
                  return client.run({
                    maxAttempts: config.zhjwMaxAttempts || 3,
                    dryRun: !!dryRun,
                  });
                })
                .then((result) => {
                  zhjwLog("info", `${result.ok ? "✅" : "❌"} ${result.message || ""}`);
                })
                .catch((err) => {
                  zhjwLog("error", `异常：${err && err.message ? err.message : err}`);
                });
              return undefined;
            }

            // wjiaowu / auto 渠道：走随堂评价流程
            sendJson(res, 200, { ok: true, data: { started: true, dryRun, channel: "wjiaowu" } });
            Promise.resolve()
              .then(() => runOnce(dryRun))
              .then((result) => {
                log("info", `面板立即执行：${result.ok ? "✅" : "❌"} ${result.message || ""}`);
              })
              .catch((err) => {
                log("error", `面板立即执行异常：${err && err.message ? err.message : err}`);
              });
            return undefined;
          }

          // zhjw 渠道：运行一次 zhjw 评课（账号密码 + ONNX 验证码）
          if (req.method === "POST" && url.pathname === `${WEB_ROUTE}/zhjw/run`) {
            if (state.running) {
              return sendJson(res, 409, { ok: false, error: "已有一次评课正在进行，等它结束再试" });
            }
            const body = await readJsonBody(req);
            const dryRun = body && body.dryRun === true;
            if (!config.zhjwEnabled) {
              return sendJson(res, 400, { ok: false, error: "zhjw 渠道未启用，请先在设置中打开「启用 zhjw 渠道」" });
            }
            if (!config.zhjwAccount || !config.zhjwPassword) {
              return sendJson(res, 400, { ok: false, error: "zhjw 账号或密码未配置，请在设置中填写统一身份认证账号密码" });
            }
            sendJson(res, 200, { ok: true, data: { started: true, dryRun } });
            // zhjw 运行日志同时写 run.log，便于在 DSH 外部查看与排障
            const zhjwLog = (level, msg) => {
              log(level, `[zhjw] ${msg}`);
              try {
                ensureDataDir();
                fs.appendFileSync(
                  RUN_LOG,
                  `[${new Date().toISOString()}] [${level}] [zhjw] ${msg}\n`,
                  "utf8"
                );
              } catch {}
            };
            Promise.resolve()
              .then(() => {
                // 默认用浏览器键鼠模拟（更真实）；body.http=true 可切回纯 HTTP 模式
                const useHttp = body && body.http === true;
                const ClientClass = useHttp ? ZhjwClient : ZhjwBrowserClient;
                zhjwLog("info", `模式：${useHttp ? "纯 HTTP" : "浏览器键鼠模拟"}`);
                const client = new ClientClass({
                  account: config.zhjwAccount,
                  password: config.zhjwPassword,
                  log: zhjwLog,
                  config: config,
                });
                return client.run({
                  maxAttempts: config.zhjwMaxAttempts || 3,
                  dryRun: !!dryRun,
                });
              })
              .then((result) => {
                zhjwLog("info", `${result.ok ? "✅" : "❌"} ${result.message || ""}`);
              })
              .catch((err) => {
                zhjwLog("error", `异常：${err && err.message ? err.message : err}`);
              });
            return undefined;
          }

          // zhjw 渠道：检查配置
          if (req.method === "POST" && url.pathname === `${WEB_ROUTE}/zhjw/check`) {
            return sendJson(res, 200, {
              ok: true,
              data: {
                channel: config.channel,
                zhjwEnabled: config.zhjwEnabled === true,
                zhjwAccount: config.zhjwAccount || "(空)",
                zhjwPassword: config.zhjwPassword ? "(已配置)" : "(空)",
                zhjwMaxAttempts: config.zhjwMaxAttempts || 3,
                zhjwRetryDelayMinutes: config.zhjwRetryDelayMinutes || 15,
              },
            });
          }

          if (req.method === "POST" && url.pathname === `${WEB_ROUTE}/config`) {
            const body = await readJsonBody(req);
            const patch = sanitizePatch(body && typeof body.patch === "object" ? body.patch : {});
            if (Object.keys(patch).length === 0) {
              return sendJson(res, 400, { ok: false, error: "没有可写入的字段" });
            }
            const editor = ctx.get("configEditor");
            if (editor === undefined) {
              return sendJson(res, 503, {
                ok: false,
                error: "本部署没有配置编辑服务，请直接改 cordis.patch.yml",
              });
            }
            const entry = findOwnEntry(editor);
            if (entry === undefined) {
              return sendJson(res, 409, {
                ok: false,
                error: `找不到配置条目（id=${ENTRY_ID} / 包名 ${PACKAGE_NAME}）；请直接改 cordis.patch.yml`,
              });
            }
            // 先回包再写盘：写入会触发 Loader 重载本插件，连这条路由一起重建，
            // 等它完成再回包多半连不上。面板收到 ok 后自己再拉一次配置。
            sendJson(res, 200, { ok: true, data: { applying: true, fields: Object.keys(patch) } });
            Promise.resolve()
              .then(() => editor.edit(entry, (current) => ({ ...current, ...patch })))
              .catch((err) => {
                log("warn", `写配置失败：${err && err.message ? err.message : err}`);
              });
            return undefined;
          }

          return sendJson(res, 404, { ok: false, error: "未知端点" });
        },
      })
    );
    log("info", `配置端点已挂载：${WEB_ROUTE}`);
  });

  // 插件被禁用/卸载时，清理 Windows 计划任务，避免孤儿任务触发后找不到 DSH 服务
  const cleanupSystemTasks = () => {
    try {
      const wanted = Array.isArray(config.runTimes) ? config.runTimes : DEFAULT_RUN_TIMES;
      let known = [];
      try {
        const snapshot = JSON.parse(fs.readFileSync(CONFIG_SNAPSHOT, "utf8"));
        if (snapshot && snapshot.__meta && Array.isArray(snapshot.__meta.systemTasks)) {
          known = snapshot.__meta.systemTasks;
        }
      } catch {}
      const toDelete = new Set([...known, ...wanted.map(hhmmToTaskName)]);
      for (const name of toDelete) {
        try {
          schtasks(["/Delete", "/F", "/TN", name]);
          log("info", `已删除计划任务 ${name}`);
        } catch {
          // 本来就不存在：忽略
        }
      }
      try {
        exportConfigSnapshot({ ...config, systemTask: false }, {
          enabled: false,
          tasks: [],
          error: "",
        });
      } catch {}
    } catch (err) {
      log("warn", `清理计划任务失败：${err && err.message ? err.message : err}`);
    }
  };

  return () => {
    cleanupSystemTasks();
    if (scheduleDisposer) scheduleDisposer();
    for (const d of disposers) {
      if (typeof d === "function") d();
    }
    log("info", "南医大随堂评价助手已卸载");
  };
}
