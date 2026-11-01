#!/usr/bin/env node
/**
 * 把「插件版」里两个版本共用的文件，单向同步到「独立版」。
 *
 * 为什么需要这个脚本：
 *   插件版（DSH 里跑）和独立版（绿色版，打包成 zip 分发）共用大量代码——
 *   browser.js、zhjw-client/browser、config.mjs、dispatch/run-* 脚本、ui.html 等。
 *   独立版要能独立分发，不能依赖符号链接，所以只能存一份实体文件。
 *   以前靠手工复制 + 手改 import 路径，改功能时容易漏（曾经漏过建议评语池）。
 *   现在统一从插件版同步，路径改写规则写死在本脚本里，同步一次即可。
 *
 * 用法：
 *   node tools/sync-standalone.mjs                 # 同步（默认找同级 smueval-bot-standalone）
 *   node tools/sync-standalone.mjs --check         # 只报告差异，不写文件
 *   node tools/sync-standalone.mjs --target <目录>  # 指定独立版目录
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const DEFAULT_TARGET = path.resolve(PLUGIN_ROOT, "..", "smueval-bot-standalone");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const targetIdx = args.indexOf("--target");
const TARGET_ROOT = targetIdx >= 0 && args[targetIdx + 1] ? path.resolve(args[targetIdx + 1]) : DEFAULT_TARGET;

/** 独立版的路径形状：config.mjs / zhjw-*.mjs 放在 lib/ 下，其余脚本在根目录。 */
const RULES = [
  // ---- 纯复制（只 import node 内置模块，或与路径无关） ----
  { src: "browser.js", dst: "browser.js" },
  { src: "ui.html", dst: "ui.html" },
  { src: "tools/config.mjs", dst: "lib/config.mjs" },
  { src: "tools/zhjw-client.mjs", dst: "lib/zhjw-client.mjs" },
  { src: "tools/zhjw-browser.mjs", dst: "lib/zhjw-browser.mjs" },
  { src: "tools/captcha_solver.py", dst: "tools/captcha_solver.py" },
  { src: "tools/notify.ps1", dst: "tools/notify.ps1" },
  { src: "tools/wechat-token.ps1", dst: "tools/wechat-token.ps1" },

  // ---- 需要改写 import / 资源路径的脚本 ----
  {
    src: "tools/dispatch.mjs",
    dst: "dispatch.mjs",
    rewrites: [['"./config.mjs"', '"./lib/config.mjs"']],
  },
  {
    src: "tools/run-zhjw.mjs",
    dst: "run-zhjw.mjs",
    rewrites: [
      ['"./config.mjs"', '"./lib/config.mjs"'],
      ['"./zhjw-browser.mjs"', '"./lib/zhjw-browser.mjs"'],
      ['"./zhjw-client.mjs"', '"./lib/zhjw-client.mjs"'],
    ],
  },
  {
    src: "tools/run-once.mjs",
    dst: "run-once.mjs",
    rewrites: [
      ['"./config.mjs"', '"./lib/config.mjs"'],
      // 插件版脚本在 tools/ 下，browser.js 在父目录；独立版都在根目录
      ['"../browser.js"', '"./browser.js"'],
      // 插件版的 ps1 与脚本同目录（tools/）；独立版在 tools/ 子目录
      ['path.join(HERE, "wechat-token.ps1")', 'path.join(HERE, "tools", "wechat-token.ps1")'],
      ['path.join(HERE, "notify.ps1")', 'path.join(HERE, "tools", "notify.ps1")'],
      // 回执里的来源标记：插件版是计划任务，独立版是 standalone
      ['source: "system-task"', 'source: "standalone"'],
    ],
  },
];

function applyRewrites(text, rewrites) {
  let out = text;
  for (const [from, to] of rewrites || []) {
    out = out.split(from).join(to);
  }
  return out;
}

function sha(text) {
  // 用轻量对比即可：直接比字符串
  return text;
}

function main() {
  if (!fs.existsSync(TARGET_ROOT)) {
    console.error(`✗ 独立版目录不存在：${TARGET_ROOT}`);
    console.error("  用 --target <目录> 指定，或把两个项目放在同一父目录下。");
    process.exit(1);
  }

  console.log(`源（插件版）：${PLUGIN_ROOT}`);
  console.log(`目标（独立版）：${TARGET_ROOT}`);
  console.log(checkOnly ? "模式：只检查，不写文件\n" : "模式：同步\n");

  const rows = [];
  let changed = 0;
  let same = 0;
  let missing = 0;

  for (const rule of RULES) {
    const srcPath = path.join(PLUGIN_ROOT, rule.src);
    const dstPath = path.join(TARGET_ROOT, rule.dst);

    if (!fs.existsSync(srcPath)) {
      rows.push({ file: rule.src, status: "源缺失", detail: "" });
      missing += 1;
      continue;
    }

    const srcText = fs.readFileSync(srcPath, "utf8");
    const dstText = applyRewrites(srcText, rule.rewrites);
    const exists = fs.existsSync(dstPath);
    const oldText = exists ? fs.readFileSync(dstPath, "utf8") : null;

    if (oldText === dstText) {
      rows.push({ file: rule.dst, status: "已一致", detail: "" });
      same += 1;
      continue;
    }

    if (!checkOnly) {
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.writeFileSync(dstPath, dstText, "utf8");
    }
    rows.push({ file: rule.dst, status: exists ? "已更新" : "新建", detail: rule.rewrites ? "含路径改写" : "" });
    changed += 1;
  }

  const w = Math.max(...rows.map((r) => r.file.length), 8);
  for (const r of rows) {
    const icon = r.status === "已一致" ? "=" : r.status === "源缺失" ? "!" : "*";
    console.log(` ${icon} ${r.file.padEnd(w)}  ${r.status}${r.detail ? "  " + r.detail : ""}`);
  }

  console.log(`\n汇总：更新 ${changed} 个，已一致 ${same} 个${missing ? `，源缺失 ${missing} 个` : ""}`);
  if (checkOnly && changed > 0) {
    console.log("（--check 模式，未写入。去掉 --check 即可同步）");
    process.exitCode = 1;
  }
}

main();
