#!/usr/bin/env node
/**
 * 脱离 DSH 的一轮评课入口（给 Windows 计划任务用）。
 *
 * 为什么单独一个脚本：计划任务只认得"命令行"，它启动时没有 DSH Host，也就没有
 * schemastery 之类的依赖。所以这里只 import browser.js（只依赖 playwright-core），
 * 配置读插件导出的 JSON 快照。
 *
 * 用法：
 *   node run-once.mjs              # 立刻跑一轮
 *   node run-once.mjs --jitter     # 先随机等 0~runJitterMinutes 分钟再跑（避开整点）
 *   node run-once.mjs --check      # 只打印读到的配置，不开浏览器（自检用）
 *   node run-once.mjs --dry-run    # 强制试运行：只点不提交
 *
 * 产物（都在 %LOCALAPPDATA%\smueval-bot\）：
 *   config.json    插件导出的配置快照（只读）
 *   run.cmd        计划任务实际调用的批处理（由插件生成）
 *   last-run.json  最近一次结果（DSH 面板会读它显示回执）
 *   runs.jsonl     历史记录，一行一次
 *   run.log        计划任务模式的输出日志
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "smueval-bot");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const LAST_RUN_FILE = path.join(DATA_DIR, "last-run.json");
const HISTORY_FILE = path.join(DATA_DIR, "runs.jsonl");

const args = new Set(process.argv.slice(2));
const wantCheck = args.has("--check");
const forceDryRun = args.has("--dry-run");
const wantJitter = args.has("--jitter");
const wantRefreshToken = args.has("--refresh-token");

function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`配置快照不存在：${CONFIG_FILE}（先打开一次 DSH，让插件导出配置）`);
  }
  const raw = fs.readFileSync(CONFIG_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置快照格式不对（应为 JSON 对象）");
  }
  return parsed;
}

function writeResult(result) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const record = {
    ...result,
    source: "system-task",
    triggeredAt: new Date().toISOString(),
  };
  fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(record, null, 2), "utf8");
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + "\n", "utf8");
}

/** 计划任务固定在整点，这里把"人类感"补回来：随机 0~jitter 分钟。 */
async function sleepJitter(minutes) {
  const cap = Math.max(0, Math.min(180, Number(minutes) || 0));
  if (cap === 0) return 0;
  const seconds = Math.floor(Math.random() * cap * 60);
  log("info", `计划任务模式：先随机等待 ${Math.round(seconds / 60)} 分 ${seconds % 60} 秒（上限 ${cap} 分钟）`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return seconds;
}

const WECHAT_SCRIPT = fileURLToPath(new URL("./wechat-token.ps1", import.meta.url));

function runWeChatScript() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", WECHAT_SCRIPT],
      { encoding: "utf8", timeout: 300000, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") })
    );
  });
}

/**
 * 计划任务专用：不经过 DSH，自己把 Token 换新。
 * 步骤：跑 wechat-token.ps1（开微信/点浮窗/OCR）→ 扫 leveldb 找有效 Token → 写回配置快照。
 */
async function refreshTokenStandalone(config) {
  if (!fs.existsSync(WECHAT_SCRIPT)) {
    log("warn", "缺少 tools/wechat-token.ps1，跳过自动续期");
    return "";
  }
  log("info", "Token 失效，尝试用微信浮窗自动续期（不依赖 DSH）…");
  const { err, stdout } = await runWeChatScript();
  const line = String(stdout)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.startsWith("{") && item.endsWith("}"))
    .pop();
  let parsed = null;
  if (line) {
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || !parsed.ok) {
    log("warn", `微信续期失败：${(parsed && parsed.error) || (err && err.message) || "无输出"}`);
    return "";
  }
  log("info", `微信操作完成：${parsed.matched} @ (${parsed.clickedX},${parsed.clickedY})，关闭窗口 ${parsed.closed || 0} 个`);

  const { collectWeChatTokens, validateToken } = await import("../browser.js");
  const candidates = (collectWeChatTokens(log) || []).slice(0, 12);
  for (const token of candidates) {
    if (await validateToken(config.apiBase, token)) {
      log("info", `扫到可用 Token：${token.slice(0, 6)}…${token.slice(-4)}`);
      return token;
    }
  }
  log("warn", "微信操作完成，但没扫到有效 Token");
  return "";
}

function persistTokenToSnapshot(token) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    snapshot.token = token;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(snapshot, null, 2), "utf8");
    log("info", "新 Token 已写回配置快照（DSH 下次启动会读到它）");
  } catch (error) {
    log("warn", `写回配置快照失败：${error && error.message ? error.message : error}`);
  }
}

async function main() {
  const config = readConfig();

  if (wantCheck) {
    console.log("配置快照：" + CONFIG_FILE);
    console.log(JSON.stringify({
      ...config,
      token: config.token ? "(已配置，长度 " + String(config.token).length + ")" : "(空，将自动从微信/浏览器继承)",
    }, null, 2));
    return 0;
  }

  if (wantRefreshToken) {
    const token = await refreshTokenStandalone(config);
    if (!token) return 1;
    config.token = token;
    persistTokenToSnapshot(token);
    return 0;
  }

  if (config.enabled === false) {
    log("info", "插件配置里 enabled=false，跳过本次评课");
    return 0;
  }
  if (String(config.mode || "browser") !== "browser") {
    log("warn", `配置的 mode=${config.mode}，但计划任务模式只支持 browser（真实浏览器点击）。本次跳过。`);
    return 2;
  }

  if (wantJitter) await sleepJitter(config.runJitterMinutes);

  const cfg = { ...config };
  if (forceDryRun) cfg.skipSubmit = true;

  const startedAt = new Date().toISOString();
  log("info", `开始评课（${cfg.skipSubmit ? "试运行，不提交" : "正式提交"}）`);

  const { runBrowserRun } = await import("../browser.js");
  let raw = await runBrowserRun(cfg, log);

  // 计划任务模式下也要能自愈：Token 失效就自己换新的，然后补跑一次
  if (raw.tokenInvalid && !cfg.skipSubmit) {
    const fresh = await refreshTokenStandalone(cfg);
    if (fresh) {
      cfg.token = fresh;
      persistTokenToSnapshot(fresh);
      log("info", "用新 Token 重跑一次…");
      raw = await runBrowserRun(cfg, log);
    }
  }

  const result = {
    ok: !!raw.ok,
    dryRun: !!cfg.skipSubmit,
    evaluated: raw.evaluated || 0,
    pending: raw.pending || 0,
    message: raw.message || "",
    tokenInvalid: !!raw.tokenInvalid,
    details: raw.details || [],
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  writeResult(result);

  log(result.ok ? "info" : "error", `${result.ok ? "✅" : "❌"} ${result.message || "（无说明）"}`);
  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const message = error && error.message ? error.message : String(error);
    log("error", `运行失败：${message}`);
    try {
      writeResult({
        ok: false,
        dryRun: forceDryRun,
        evaluated: 0,
        pending: 0,
        message,
        tokenInvalid: false,
        details: [],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
    } catch {
      // 连结果都写不下去就算了
    }
    process.exit(1);
  });
