/** 浏览器自动化模块：用 Playwright 驱动真实浏览器（Edge/Chrome），像真人一样点击完成随堂评价。
 *
 * 设计要点：
 *  - 真实浏览器指纹、Referer/Origin/Cookie、静态资源加载、真实 TLS 指纹
 *  - 鼠标移动轨迹 + 按下/抬起分离 + 随机停顿（isTrusted=true）
 *  - 请求由 SPA 自己发出，payload 天然正确
 *  - 评课前有浏览噪声，不直奔评教页
 *  - 支持「补评昨天」：时效是当天和第二天，漏评的可以补
 *  - 不写死任何本机路径：浏览器、微信存储、用户 profile 全部自动探测，
 *    方便移植到别人的电脑
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/** 展开 %VAR% 形式的环境变量 */
function expandEnv(p) {
  if (!p) return "";
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] || "");
}

/** 支持的浏览器（按优先级），profileRoot 用于同步真实浏览痕迹 */
const BROWSER_CANDIDATES = [
  {
    id: "edge",
    paths: [
      "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    profileRoots: ["%LOCALAPPDATA%\\Microsoft\\Edge\\User Data"],
  },
  {
    id: "chrome",
    paths: [
      "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
      "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
      "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
    ],
    profileRoots: ["%LOCALAPPDATA%\\Google\\Chrome\\User Data"],
  },
  {
    id: "brave",
    paths: ["%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
    profileRoots: ["%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data"],
  },
];

/** 微信 PC 端的可能数据布局（不同版本差异很大），用于找 localStorage 的 leveldb */
const WECHAT_STORAGE_ROOTS = [
  "%APPDATA%\\Tencent\\xwechat\\radium\\web\\profiles",
  "%APPDATA%\\Tencent\\Weixin\\radium\\web\\profiles",
  "%APPDATA%\\Tencent\\WeChat\\radium\\web\\profiles",
  "%LOCALAPPDATA%\\Tencent\\xwechat\\radium\\web\\profiles",
  "%LOCALAPPDATA%\\Tencent\\Weixin\\radium\\web\\profiles",
];
/** 上面都没命中时的兜底：在 Tencent 目录里递归找 Local Storage/leveldb */
const WECHAT_FALLBACK_ROOTS = ["%APPDATA%\\Tencent", "%LOCALAPPDATA%\\Tencent"];

/** 建议文本模板池：长短不一，贴近真实学生随手写的口吻 */
const SUGGESTION_POOL = [
  // —— 短句（很多学生就写几个字）——
  "挺好",
  "不错",
  "老师讲得清楚",
  "没什么意见",
  "讲得很好",
  "很喜欢这门课",
  "挺好的，没有建议",
  // —— 中等篇幅、常见套话 ——
  "课程内容充实，教学认真负责，受益匪浅。",
  "老师讲解清晰有条理，课堂节奏把握得好，收获很大。",
  "教学内容丰富，重点突出，对理解课程很有帮助。",
  "老师认真负责，答疑及时，课程安排合理。",
  "整体教学效果不错，知识点梳理得比较清楚。",
  "老师备课充分，讲解耐心，课程内容有深度。",
  "课堂氛围好，讲解细致，希望能多一些案例分析。",
  "课程结构清晰，老师讲课很有条理。",
  "老师很有耐心，回答问题很细致。",
  "课件做得用心，复习的时候很有帮助。",
  "课堂互动比较多，不会觉得枯燥。",
  "老师对重点难点的把握很到位。",
  "教学进度安排合理，跟得上。",
  "希望以后能多讲一些临床相关的例子。",
  "希望能多留一点课后练习或者习题讲解。",
  "知识点讲得比较细，就是内容有点多。",
  "如果能放慢一点节奏会更好。",
  "建议多结合一些实际案例来讲。",
  // —— 稍长、带具体感受 ——
  "老师讲课很有激情，能把枯燥的内容讲得有意思。",
  "这门课让我对专业有了更清楚的认识，收获挺大。",
  "老师会结合实际例子讲解，比单纯看书好理解很多。",
  "课程内容安排紧凑，课后需要花时间消化，但很有价值。",
  "老师很愿意在课后答疑，有问题基本都能得到回复。",
  "希望能在考试前多给一些复习重点。",
  "如果课件能提前上传就更好了。",
  "整体很满意，就是希望多一些课堂讨论的环节。",
  "老师讲课思路很清楚，板书也写得不错。",
];

/** 随机抽一条建议；按 suggestionEmptyRate 概率返回空（真实学生常不填） */
function pickSuggestion(config, avoid) {
  if (config.suggestionFixed && config.suggestion) return config.suggestion;

  const emptyRate = Math.max(0, Math.min(1, Number(config.suggestionEmptyRate ?? 0.35)));
  if (emptyRate > 0 && Math.random() < emptyRate) return "";

  const pool =
    Array.isArray(config.suggestionPool) && config.suggestionPool.length
      ? config.suggestionPool
      : SUGGESTION_POOL;
  const candidates = pool.length > 1 && avoid ? pool.filter((s) => s !== avoid) : pool;
  return candidates[rand(0, candidates.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Token 失效时抛出的错误，index.js 靠 code===401 识别 */
function tokenError(message) {
  const err = new Error(message || "Token 已失效，请重新从 wjiaowu 的 localStorage 复制 Token");
  err.code = 401;
  return err;
}

/** 四星数量随机化：多数情况是 2 个，偶尔 1 或 3 个 */
function pickFourStarCount(config, rateCount) {
  const forced = Number(config.fourStarCount);
  if (Number.isFinite(forced) && forced >= 0 && config.varyFourStar !== true) {
    return Math.min(forced, Math.max(0, rateCount - 1));
  }
  const r = Math.random();
  const n = r < 0.15 ? 1 : r < 0.85 ? 2 : 3;
  return Math.min(n, Math.max(0, rateCount - 1));
}

/** 待遍历的日期：默认 今天 + 昨天（可评时效是当天和第二天） */
function buildDateList(config) {
  const lookback = Math.max(0, Number(config.lookbackDays ?? 1));
  const out = [];
  for (let i = 0; i <= lookback; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(d);
  }
  return out;
}

function buildRadioPlan(config) {
  return {
    late: config.lateAnswer || "否",
    duty: config.dutyAnswer || "无职务",
    requirement: config.requirementAnswer || "按要求完成了学习",
    selfStudy: config.selfStudyAnswer || "课程学时30%以内",
  };
}

function pickOptionForQuestion(questionText, options, plan) {
  const q = String(questionText || "");
  const has = (kw) => q.includes(kw);

  let want = null;
  if (has("迟到")) want = plan.late;
  else if (has("职务")) want = plan.duty;
  else if (has("学习要求")) want = plan.requirement;
  else if (has("自主学习的比例") || has("自主学习的占比")) want = plan.selfStudy;

  if (want && options.includes(want)) return want;
  return options[0] || null;
}

/** 带人类特征的点击：滚动到可视区 → 移动轨迹 → 停顿 → 按下 → 停顿 → 抬起 */
async function humanClick(page, locator, log) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 8000 });
  } catch {}
  await sleep(rand(150, 400));
  const box = await locator.boundingBox();
  if (!box) throw new Error("元素不可见，无法点击");
  const x = box.x + box.width / 2 + rand(-3, 3);
  const y = box.y + box.height / 2 + rand(-3, 3);
  await page.mouse.move(x, y, { steps: rand(8, 18) });
  await sleep(rand(80, 260));
  await page.mouse.down();
  await sleep(rand(45, 130));
  await page.mouse.up();
  await sleep(rand(120, 400));
}

async function humanType(page, locator, text) {
  await humanClick(page, locator);
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(rand(40, 160));
  }
}

/** 自动探测可用浏览器；返回 { id, path, profileRoot } */
function resolveBrowser(config, log) {
  const explicit = config.browserPath || config.edgePath;
  if (explicit) {
    const p = expandEnv(explicit);
    if (fs.existsSync(p)) return { id: "custom", path: p, profileRoot: "" };
    log?.("warn", `配置的浏览器路径不存在：${p}，改为自动探测`);
  }
  for (const cand of BROWSER_CANDIDATES) {
    for (const raw of cand.paths) {
      const p = expandEnv(raw);
      if (p && fs.existsSync(p)) {
        const root = expandEnv(cand.profileRoots[0]);
        return { id: cand.id, path: p, profileRoot: fs.existsSync(root) ? root : "" };
      }
    }
  }
  throw new Error(
    "未找到可用的浏览器。请安装 Microsoft Edge 或 Google Chrome，或在配置里用 browserPath 指定浏览器可执行文件路径"
  );
}

/** 真实 Edge profile 里值得继承的文件（历史、书签、Cookie、站点数据） */
const PROFILE_FILES = [
  "History",
  "Bookmarks",
  "Preferences",
  "Web Data",
  "Top Sites",
  "Favicons",
  "Shortcuts",
  "Login Data",
];
const PROFILE_NETWORK_FILES = ["Cookies", "TransportSecurity", "Trust Tokens"];

/** 在浏览器的 User Data 目录里挑一个有真实使用痕迹的 profile */
function pickBrowserProfile(profileRoot) {
  if (!profileRoot || !fs.existsSync(profileRoot)) return "";
  const preferred = ["Default", "Profile 1", "Profile 2", "Profile 3"];
  for (const name of preferred) {
    const dir = path.join(profileRoot, name);
    if (fs.existsSync(path.join(dir, "History"))) return dir;
  }
  // 退而求其次：任意带 History 的子目录
  try {
    for (const e of fs.readdirSync(profileRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(profileRoot, e.name);
      if (fs.existsSync(path.join(dir, "History"))) return dir;
    }
  } catch {}
  return "";
}

function copyIfExists(src, dst) {
  try {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch {
    return false;
  }
}

/** 把真实浏览器 profile 的浏览痕迹同步过来，避免「全新空 profile」这种机器特征 */
export function seedProfile(profileDir, config, log) {
  if (config.seedProfile === false) return { copied: 0 };
  let src = config.seedProfileFrom ? expandEnv(config.seedProfileFrom) : "";
  if (!src) {
    // 自动：优先用本次实际启动的那个浏览器的 User Data
    const browser = resolveBrowser(config, log);
    src = pickBrowserProfile(browser.profileRoot);
    if (!src) {
      // 再退：任意一个已安装浏览器的 profile
      for (const cand of BROWSER_CANDIDATES) {
        const root = expandEnv(cand.profileRoots[0]);
        const picked = pickBrowserProfile(root);
        if (picked) {
          src = picked;
          break;
        }
      }
    }
  }
  if (!src || !fs.existsSync(src)) return { copied: 0 };

  let copied = 0;
  try {
    for (const f of PROFILE_FILES) {
      if (copyIfExists(path.join(src, f), path.join(profileDir, f))) copied += 1;
    }
    for (const f of PROFILE_NETWORK_FILES) {
      if (copyIfExists(path.join(src, "Network", f), path.join(profileDir, "Network", f))) copied += 1;
    }
    const lsSrc = path.join(src, "Local Storage", "leveldb");
    if (fs.existsSync(lsSrc)) {
      const lsDst = path.join(profileDir, "Local Storage", "leveldb");
      fs.mkdirSync(lsDst, { recursive: true });
      for (const f of fs.readdirSync(lsSrc)) {
        if (copyIfExists(path.join(lsSrc, f), path.join(lsDst, f))) copied += 1;
      }
    }
    log("info", `已同步真实 profile ${copied} 个文件（历史/书签/Cookie/站点数据）`);
  } catch (err) {
    log("warn", `profile 同步部分失败：${err.message}`);
  }
  return { copied };
}

/** 找出所有 Local Storage/leveldb 目录（跨微信版本自动探测） */
function findWeChatLeveldbDirs(log) {
  const out = new Set();

  // 1) 已知布局直接命中
  for (const raw of WECHAT_STORAGE_ROOTS) {
    const base = expandEnv(raw);
    if (!base || !fs.existsSync(base)) continue;
    try {
      for (const prof of fs.readdirSync(base)) {
        const lv = path.join(base, prof, "Local Storage", "leveldb");
        if (fs.existsSync(lv)) out.add(lv);
      }
    } catch {}
  }
  if (out.size) return [...out];

  // 2) 兜底：在 Tencent 目录里有限深度递归找
  const walk = (dir, depth) => {
    if (depth > 7) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === "Local Storage") {
        const lv = path.join(p, "leveldb");
        if (fs.existsSync(lv)) out.add(lv);
        continue;
      }
      walk(p, depth + 1);
    }
  };
  for (const raw of WECHAT_FALLBACK_ROOTS) {
    const base = expandEnv(raw);
    if (base && fs.existsSync(base)) walk(base, 0);
  }
  if (out.size) log?.("info", `微信存储探测：命中 ${out.size} 个 leveldb 目录（通用递归）`);
  return [...out];
}

/** 从微信 PC 端的 Chromium leveldb 里收集候选 Token（不做网络验证，只扫本地文件）。
 *
 * 微信内置浏览器是 Chromium 内核，网页的 localStorage 存在 leveldb 里。
 * 用户在微信里重新登录后，新 Token 会落到这里，于是可以自动继承，不用手工复制。
 * 路径跨版本差异很大，因此用 detect + 递归兜底的方式查找。
 */
export function collectWeChatTokens(log) {
  const scored = new Map();
  let dirs;
  try {
    dirs = findWeChatLeveldbDirs(log);
  } catch (err) {
    log?.("warn", `扫描微信存储失败：${err.message}`);
    return [];
  }

  for (const ls of dirs) {
    let files;
    try {
      files = fs.readdirSync(ls);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.(ldb|log)$/.test(f)) continue;
      let ascii;
      try {
        ascii = fs.readFileSync(path.join(ls, f)).toString("latin1");
      } catch {
        continue;
      }
      if (!ascii.includes("wjiaowu")) continue;

      // 记录所有 wjiaowu 出现位置，用于计算候选与它的距离
      const anchors = [];
      let p = ascii.indexOf("wjiaowu");
      while (p >= 0) {
        anchors.push(p);
        p = ascii.indexOf("wjiaowu", p + 1);
      }

      for (const m of ascii.matchAll(/\b[0-9a-f]{32}\b/g)) {
        const t = m[0];
        if (/^(.)\1{31}$/.test(t)) continue;
        const dist = Math.min(...anchors.map((a) => Math.abs(a - m.index)));
        const prev = scored.get(t);
        if (!prev || dist < prev) scored.set(t, dist);
      }
    }
  }

  // 离 wjiaowu 字样越近越可能是本站的 Token，按距离升序返回
  return [...scored.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
}

/** 用页面上下文里的 Token 探测登录态（getIstoken 会返回 code:200） */
async function checkLogin(page) {
  try {
    return await page.evaluate(async () => {
      const t = localStorage.getItem("Token");
      if (!t) return false;
      try {
        const r = await fetch("/dev-api/appapi/getIstoken", { headers: { token: t } });
        const j = await r.json();
        return !!(j && j.code === 200);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** 判断是否已被踢回登录页（Token 失效） */
async function assertLoggedIn(page) {
  const url = page.url();
  if (url.includes("/login")) {
    throw tokenError("页面被重定向到登录页，Token 已失效");
  }
  const text = await page.evaluate(() => (document.body.innerText || "").slice(0, 300)).catch(() => "");
  if (text.includes("请先登录") || text.includes("登录已失效")) {
    throw tokenError("页面提示「请先登录」，Token 已失效");
  }
}

/** 通过 van-picker 选择指定日期 */
async function setDateTo(page, dateObj, log) {
  const want = {
    year: String(dateObj.getFullYear()),
    month: String(dateObj.getMonth() + 1).padStart(2, "0"),
    day: String(dateObj.getDate()).padStart(2, "0"),
  };

  const cell = page.locator(".van-cell", { hasText: "日期" }).first();
  if ((await cell.count()) === 0) return false;

  // 已经是目标日期就不用动
  const shown = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".van-cell__value span")].find((s) =>
      /^\d{4}-\d{2}-\d{2}$/.test((s.innerText || "").trim())
    );
    return el ? el.innerText.trim() : "";
  });
  if (shown === formatDate(dateObj)) return true;

  await humanClick(page, cell, log);
  await sleep(rand(1200, 2200));

  // 逐列点选（年 / 月 / 日），每次重新查询，防止联动后元素失效
  const targets = [want.year, want.month, want.day];
  for (let col = 0; col < targets.length; col++) {
    const column = page.locator(".van-picker-column").nth(col);
    if ((await column.count()) === 0) break;
    const item = column.locator(".van-picker-column__item", { hasText: targets[col] }).first();
    if ((await item.count()) === 0) continue;
    await humanClick(page, item, log);
    await sleep(rand(500, 1200));
  }

  const confirm = page.locator(".van-picker__confirm").first();
  if ((await confirm.count()) > 0) {
    await humanClick(page, confirm, log);
    await sleep(rand(1800, 3200));
  }

  const after = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".van-cell__value span")].find((s) =>
      /^\d{4}-\d{2}-\d{2}$/.test((s.innerText || "").trim())
    );
    return el ? el.innerText.trim() : "";
  });
  log("info", `日期切换：${shown || "?"} → ${after || "?"}（目标 ${formatDate(dateObj)}）`);
  return after === formatDate(dateObj);
}

/** 扫描当前列表里可评的卡片 */
async function scanPending(page) {
  const rows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".van-row").forEach((r, i) => {
      const t = (r.innerText || "").replace(/\s+/g, " ").trim();
      if (!t) return;
      out.push({ i, text: t });
    });
    return out;
  });
  return rows.filter(
    (r) => r.text.includes("评价") && !r.text.includes("时间未到") && !r.text.includes("查看")
  );
}

/**
 * 执行一轮随堂评价（浏览器方式）
 * @returns {ok, evaluated, pending, message, details, tokenInvalid}
 */
export async function runBrowserRun(config, log) {
  const details = [];
  let ctx;
  let evaluated = 0;
  let tokenInvalid = false;

  try {
    const { chromium } = await import("playwright-core");
    const browser = resolveBrowser(config, log);
    const browserPath = browser.path;
    const profileDir = config.profileDir
      ? expandEnv(config.profileDir)
      : path.join(os.tmpdir(), `smueval-${browser.id}-profile`);

    log("info", `启动浏览器：${browserPath}（${browser.id}）`);

    // 先同步真实 profile 痕迹（必须在启动前，避免文件被锁）
    seedProfile(profileDir, config, log);

    const launchArgs = ["--disable-blink-features=AutomationControlled"];
    if (config.windowSize) launchArgs.push(`--window-size=${config.windowSize}`);

    const launchOptions = {
      executablePath: browserPath,
      headless: config.headless === true,
      // viewport: null = 不伪造视口，直接读真实窗口与显示器参数
      // （screen / availHeight / devicePixelRatio 全部变成真实值）
      viewport:
        config.useRealViewport === false
          ? { width: Number(config.viewportWidth) || 1024, height: Number(config.viewportHeight) || 800 }
          : null,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      args: launchArgs,
    };
    // 默认不覆盖 UA：让 Playwright 用真实浏览器的版本号，
    // 这样 UA 与本机实际浏览器完全一致（也免去移植时改 UA）
    if (config.userAgent) launchOptions.userAgent = config.userAgent;

    ctx = await chromium.launchPersistentContext(profileDir, launchOptions);

    // 注意：这里不再强制写死配置里的 Token。
    // profile 是从真实 Edge 同步过来的，里面可能已经有更新的 Token
    // （用户如果在自己的 Edge 里重新登录过，这里会自动继承，无需改配置）。
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.setDefaultTimeout(30000);

    log("info", "打开平台首页…");
    await page.goto("https://wjiaowu.smu.edu.cn/#/work", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(rand(5000, 9000));

    // Token 解析顺序：微信端（自动更新）→ 浏览器 profile → 配置里的
    // 微信端优先级最高：用户在微信里一登录，新 Token 就落到 leveldb，这里自动继承。
    const profileToken = await page.evaluate(() => {
      try {
        return localStorage.getItem("Token") || "";
      } catch {
        return "";
      }
    });

    const tryToken = async (tok) =>
      page.evaluate(async (t) => {
        try {
          localStorage.setItem("Token", t);
        } catch {}
        try {
          const r = await fetch("/dev-api/appapi/getIstoken", { headers: { token: t } });
          const j = await r.json();
          return !!(j && j.code === 200);
        } catch {
          return false;
        }
      }, tok);

    const wxTokens = config.readWeChatToken === false ? [] : collectWeChatTokens(log);
    if (wxTokens.length) log("info", `微信端扫描到 ${wxTokens.length} 个候选 Token`);

    let chosen = "";
    let tokenSource = "";

    for (const t of wxTokens.slice(0, 15)) {
      if (t === profileToken) continue;
      if (await tryToken(t)) {
        chosen = t;
        tokenSource = "wechat";
        break;
      }
    }
    if (!chosen && profileToken && (await tryToken(profileToken))) {
      chosen = profileToken;
      tokenSource = "profile";
    }
    if (!chosen && config.token && (await tryToken(config.token))) {
      chosen = config.token;
      tokenSource = "config";
    }
    if (!chosen) {
      throw tokenError(
        "所有 Token 均已失效。请在【电脑版微信】里打开一次 wjiaowu.smu.edu.cn 并登录（手机微信不行，不会写到这台电脑上），之后插件会自动继承新 Token，无需手工复制"
      );
    }

    // 回写选中的 Token 并重新加载，确保 SPA 用上它
    await page.evaluate((t) => {
      try {
        localStorage.setItem("Token", t);
      } catch {}
    }, chosen);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(rand(3500, 6500));

    const sourceLabel =
      tokenSource === "wechat"
        ? "微信端（自动继承）"
        : tokenSource === "profile"
          ? "浏览器 profile（自动继承）"
          : "配置中的 Token";
    log("info", `登录态来源：${sourceLabel}`);
    if (!(await checkLogin(page))) {
      throw tokenError(`选中的 ${sourceLabel} 在页面加载后仍无效`);
    }

    // 浏览噪声：像真人一样在首页停留、滚动
    try {
      const scrolls = rand(2, 5);
      for (let i = 0; i < scrolls; i++) {
        await page.mouse.wheel(0, rand(120, 420));
        await sleep(rand(600, 1800));
      }
      await sleep(rand(2000, 5000));
      await page.mouse.wheel(0, -rand(400, 900));
      await sleep(rand(800, 2000));
      log("info", "首页浏览完成");
    } catch {}

    await assertLoggedIn(page);

    log("info", "进入教学评价页…");
    await page.goto("https://wjiaowu.smu.edu.cn/#/appXspj", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(rand(4000, 7000));
    await assertLoggedIn(page);

    // 切到目标 tab
    const tabText = config.tabText || "随堂评";
    const stTab = page.locator(".van-tabbar-item", { hasText: tabText }).first();
    await humanClick(page, stTab, log);
    await sleep(rand(3000, 5000));
    log("info", `已切到「${tabText}」`);

    const maxPerRun = Math.max(1, Number(config.maxPerRun) || 10);
    const dates = buildDateList(config);
    let done = 0;
    let lastSuggestion = "";

    for (const dateObj of dates) {
      if (done >= maxPerRun) break;
      const dstr = formatDate(dateObj);
      log("info", `— 处理日期 ${dstr} —`);

      try {
        await setDateTo(page, dateObj, log);
        await assertLoggedIn(page);
      } catch (err) {
        if (err.code === 401) throw err;
        log("warn", `日期切换失败：${err.message}`);
      }

      // 切到「未评价」
      const unTab = page.locator(".van-tabs__nav .van-tab", { hasText: "未评价" }).first();
      if ((await unTab.count()) > 0) {
        await humanClick(page, unTab, log);
        await sleep(rand(1500, 3000));
      }

      let guard = 0;
      while (done < maxPerRun && guard < 20) {
        guard += 1;

        const pending = await scanPending(page);
        if (pending.length === 0) {
          log("info", `  ${dstr} 没有可评的课节`);
          break;
        }

        const target = pending[0];
        const name = target.text.replace(/评价\s*$/, "").trim();
        log("info", `  处理：${name}`);

        try {
          await humanClick(page, page.locator(".van-row").nth(target.i), log);
          await sleep(rand(2500, 5000));

          await page.locator(".van-rate").first().waitFor({ state: "visible", timeout: 20000 });

          // 1) 打星
          const rateCount = await page.locator(".van-rate").count();
          const fourCount = pickFourStarCount(config, rateCount);
          const idxs = Array.from({ length: rateCount }, (_, i) => i);
          for (let i = idxs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
          }
          const fourSet = new Set(idxs.slice(0, fourCount));

          for (let i = 0; i < rateCount; i++) {
            const stars = fourSet.has(i) ? 4 : 5;
            const item = page.locator(".van-rate").nth(i).locator(".van-rate__item").nth(stars - 1);
            await humanClick(page, item, log);
            await sleep(rand(1200, 3500)); // 模拟读题
          }
          log("info", `    打星 ${rateCount} 题（${fourCount} 个四星）`);

          // 2) 单选
          const radioPlan = buildRadioPlan(config);
          const radioGroups = await page.evaluate(() =>
            [...document.querySelectorAll(".van-radio-group")].map((g, i) => {
              let q = "";
              let p = g.parentElement;
              for (let k = 0; k < 4 && p; k++) {
                const t = (p.innerText || "").trim();
                if (t) {
                  q = t;
                  break;
                }
                p = p.parentElement;
              }
              return {
                i,
                q: q.replace(/\s+/g, " ").slice(0, 120),
                opts: [...g.querySelectorAll(".van-radio")].map((r) => r.innerText.trim()),
              };
            })
          );
          for (const grp of radioGroups) {
            const want = pickOptionForQuestion(grp.q, grp.opts, radioPlan);
            if (!want) continue;
            const opt = page
              .locator(".van-radio-group")
              .nth(grp.i)
              .locator(".van-radio", { hasText: want })
              .first();
            if ((await opt.count()) > 0) {
              await humanClick(page, opt, log);
              await sleep(rand(300, 900));
            }
          }

          // 3) 建议文本（选填：有一部分课程会留空）
          if (config.fillSuggestion !== false) {
            const ta = page.locator("textarea").first();
            if ((await ta.count()) > 0) {
              const text = pickSuggestion(config, lastSuggestion);
              if (text) {
                lastSuggestion = text;
                await humanType(page, ta, text);
                await sleep(rand(900, 2200));
                log("info", `    已填建议：${text.slice(0, 16)}…`);
              } else {
                log("info", "    建议留空（选填）");
              }
            }
          }

          // 4) 提交
          if (config.skipSubmit) {
            const info = await page.evaluate(() => {
              let score = "";
              for (const el of document.querySelectorAll("*")) {
                const t = (el.innerText || "").trim();
                if (/^综合评分/.test(t) && t.length < 60) {
                  score = t.replace(/\s+/g, " ");
                  break;
                }
              }
              const rates = [...document.querySelectorAll(".van-rate")].map((r) => {
                const items = [...r.querySelectorAll(".van-rate__item")];
                let n = 0;
                items.forEach((it, i) => {
                  if (it.getAttribute("aria-checked") === "true") n = i + 1;
                });
                return n;
              });
              const tas = [...document.querySelectorAll("textarea")].map((t) => t.value);
              return { score, rates, tas };
            });
            log("info", `    [试运行] ${info.score} 星=${JSON.stringify(info.rates)}`);
            details.push({ name, date: dstr, status: "dry-run", ...info });
            evaluated += 1;
            done += 1;
            const backBtn = page.locator(".van-nav-bar__left").first();
            if ((await backBtn.count()) > 0) {
              await humanClick(page, backBtn, log);
              await sleep(rand(1500, 3000));
            }
            await sleep(rand(1500, 3000));
            continue;
          }

          const submit = page.locator(".van-tabbar-item", { hasText: "提交" }).first();
          await humanClick(page, submit, log);
          await sleep(rand(1200, 2200));

          const confirm = page.locator(".van-dialog__confirm").first();
          if ((await confirm.count()) > 0) {
            await humanClick(page, confirm, log);
            await sleep(rand(2500, 4500));
          }

          const toast = await page.evaluate(() => {
            const el = document.querySelector(".van-toast__text, .van-notify__text");
            return el ? (el.innerText || "").trim() : "";
          });
          if (toast) log("info", `    提示：${toast}`);
          if (/登录/.test(toast)) throw tokenError(`提交时提示：${toast}`);
          if (/请|未|不能|失败/.test(toast)) throw new Error(`提交被拦下：${toast}`);

          try {
            await page.locator(".van-rate").first().waitFor({ state: "hidden", timeout: 20000 });
          } catch {}

          evaluated += 1;
          done += 1;
          details.push({ name, date: dstr, status: "ok" });
          log("info", `    ✅ ${name} 已提交`);

          const back = page.locator(".van-nav-bar__left").first();
          if ((await back.count()) > 0 && (await back.isVisible().catch(() => false))) {
            await humanClick(page, back, log);
            await sleep(rand(1200, 2500));
          }
        } catch (err) {
          if (err.code === 401) throw err;
          details.push({ name, date: dstr, status: "failed", error: err.message });
          log("error", `    ❌ ${name} 失败：${err.message}`);
          done += 1;
          try {
            await page.keyboard.press("Escape");
            await sleep(1500);
          } catch {}
        }

        // 课与课之间：走配置的间隔（受 dryRun 影响也照样生效）
        if (done < maxPerRun) {
          const base = Math.max(0, Number(config.intervalMs) || 0);
          const jitter = Math.max(0, Number(config.jitterMs) || 0);
          const wait = base + (jitter > 0 ? rand(0, jitter) : 0);
          if (wait > 0) {
            log("info", `    等待 ${(wait / 1000).toFixed(0)} 秒…`);
            await sleep(wait);
          }
        }
      }
    }

    const okAll = details.every((d) => d.status === "ok" || d.status === "dry-run");
    return {
      ok: details.length === 0 ? true : okAll,
      evaluated,
      pending: details.length,
      tokenInvalid: false,
      message:
        details.length === 0
          ? "没有可评的课节"
          : `浏览器评课完成：成功 ${evaluated} 条，共处理 ${details.length} 条`,
      details,
    };
  } catch (err) {
    if (err.code === 401) tokenInvalid = true;
    return {
      ok: false,
      evaluated,
      pending: details.length,
      tokenInvalid,
      message: err.code === 401 ? `Token 已失效：${err.message}` : `浏览器流程异常：${err.message}`,
      details,
    };
  } finally {
    try {
      if (ctx) await ctx.close();
    } catch {}
  }
}
