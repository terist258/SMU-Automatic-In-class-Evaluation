#!/usr/bin/env node
/**
 * 只读诊断：把一门待评课的问卷原样打印出来，并标出「插件会选哪一项」。
 * 不提交任何东西。用来核对判断题是不是都落在「否」上。
 *
 * 用法：node inspect-form.mjs [--all]
 *   --all  列出所有题目（默认只列前若干项）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "smueval-bot");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const showAll = process.argv.includes("--all");

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const apiBase = String(config.apiBase || "https://wjiaowu.smu.edu.cn/dev-api").replace(/\/$/, "");

function headers() {
  return {
    token: config.token || "",
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=utf-8",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  };
}

async function call(p, body, method = "POST") {
  const useGet = method === "GET";
  const res = await fetch(apiBase + p, {
    method: useGet ? "GET" : "POST",
    headers: headers(),
    body: useGet ? undefined : JSON.stringify(body === undefined ? {} : body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口 ${p} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
}

const NEG = ["否", "没有", "无", "不存在", "未"];
function choose(item, stars) {
  const sels = item.selections || [];
  if (!sels.length) return { label: "(无选项)", score: 0 };
  const tx = String(item.txdm);
  if (tx === "5") {
    const pick = sels[Math.min(stars, sels.length) - 1];
    return { label: "★".repeat(stars), score: ((Number(item.zbfz) || 0) / sels.length) * stars };
  }
  if (tx === "1") {
    const preferred = "否";
    const sel =
      sels.find((s) => String(s.zbxmmc || "").trim() === preferred) ||
      sels.find((s) => NEG.includes(String(s.zbxmmc || "").trim())) ||
      sels.find((s) => NEG.some((w) => String(s.zbxmmc || "").includes(w))) ||
      sels[sels.length - 1];
    return { label: sel.zbxmmc, score: (Number(sel.fzbl) || 0) * (Number(item.zbfz) || 0) / 100 };
  }
  if (tx === "3") {
    return { label: config.suggestion || "", score: Number(item.zbfz) || 0 };
  }
  return { label: "(跳过)", score: 0 };
}

const idx = await call("/appapi/Studentpjwj/index", undefined, "GET");
if (idx.code !== 200) {
  console.log(`Token 无效或接口异常：${idx.msg || idx.code}`);
  process.exit(1);
}
const XNXQDM = idx.xnxqdm;
console.log(`学期：${idx.xnxqmc || XNXQDM}`);

const list = await call("/appapi/Studentpjwj/clazz", { xnxqdm: XNXQDM });
const all = Array.isArray(list.allPjxxList) ? list.allPjxxList : [];
const pending = all.filter((c) => !c.pjdm && Number(c.passed) === 1);
console.log(`可评课节：${pending.length} 门 / 共 ${all.length} 门  （${list.msg || ""}）\n`);
if (pending.length === 0) process.exit(0);

const target = pending[0];
console.log(`第一门：${target.kcmc || target.ktpj || ""} / ${target.skjsmc || ""} / ${target.skrq || ""}`);
const form = await call("/appapi/Studentpjwj/pjClass", { dgksdm: target.dgksdm, teadm: target.teadm });
const wtList = form.wtList || [];
console.log(`题目共 ${wtList.length} 项：\n`);

let total = 0;
let starSeen = 0;
for (const item of wtList) {
  const tx = String(item.txdm);
  const sels = (item.selections || []).map((s) => s.zbxmmc).join(" / ");
  let picked;
  if (tx === "5") {
    const four = starSeen < 2 ? 4 : 5;
    starSeen += 1;
    picked = choose(item, four);
  } else {
    picked = choose(item, 5);
  }
  total += picked.score;
  const shown = showAll || tx !== "3";
  if (shown) {
    console.log(`[txdm=${tx}] ${item.zbmc}  （满分 ${item.zbfz}）`);
    console.log(`   选项：${sels}`);
    console.log(`   插件会选：${picked.label}   得分 ${Math.round(picked.score * 100) / 100}\n`);
  }
}
console.log(`合计得分：${Math.round(total * 100) / 100} / ${form.skInfo ? form.skInfo.zbfz || "" : ""}`);
