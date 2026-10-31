// 客户端 apply 的离线回归测试：模拟 DSH 客户端 ctx，验证任何情况下都不抛异常。
// 用法：node tools/test-client-apply.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "client.js");
const source = fs.readFileSync(file, "utf8");

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
}

/** 收集 factory 返回的模块对象。 */
function loadModule({ fetchImpl }) {
  let captured;
  globalThis.window = {
    __ModuleLoader__: {
      load(options) {
        captured = options;
      },
    },
  };
  const previousFetch = globalThis.fetch;
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl;
  try {
    // eslint-disable-next-line no-new-func
    new Function("window", source)(globalThis.window);
  } finally {
    globalThis.fetch = previousFetch;
  }
  if (captured === undefined) throw new Error("模块没有调用 __ModuleLoader__.load");
  return captured.factory(() => fakeReact());
}

/** 构造一个可控的 ctx。 */
function makeCtx({ undeclared = [], failFetch = false } = {}) {
  const log = { injected: [], registered: [], warnings: [], effects: 0 };
  const ctx = {
    slots: {
      inject(name, callback) {
        if (undeclared.includes(name)) {
          throw new Error(`slot "${name}" is not declared (a parent entry's children table must declare it)`);
        }
        log.injected.push(name);
        const disposer = callback();
        return typeof disposer === "function" ? disposer : () => {};
      },
      register(options) {
        log.registered.push(`${options.name}#${options.key ?? options.id ?? ""}`);
        return () => {};
      },
    },
    effect(callback, label) {
      log.effects += 1;
      const disposer = callback();
      log.effectLabels = log.effectLabels ?? [];
      log.effectLabels.push(label);
      return typeof disposer === "function" ? disposer : () => {};
    },
  };
  if (failFetch) {
    globalThis.fetch = () => {
      throw new TypeError("Failed to parse URL from /api/smueval-bot/config");
    };
  }
  return { ctx, log };
}

const cases = [
  {
    name: "正常环境（所有槽位都在）",
    options: {},
    expectInjected: ["plugins.bundle.config", "plugins.row.config", "conversation.composer.dock"],
  },
  {
    name: "老版本 DSH：没有 plugins.row.config",
    options: { undeclared: ["plugins.row.config"] },
    expectInjected: ["plugins.bundle.config", "conversation.composer.dock"],
  },
  {
    name: "更老的 DSH：两个配置槽位都没有",
    options: { undeclared: ["plugins.row.config", "plugins.bundle.config"] },
    expectInjected: ["conversation.composer.dock"],
  },
  {
    name: "连 conversation.composer.dock 都没有",
    options: { undeclared: ["plugins.row.config", "plugins.bundle.config", "conversation.composer.dock"] },
    expectInjected: [],
  },
  {
    name: "自定义协议下 fetch 直接抛异常",
    options: { failFetch: true },
    expectInjected: ["plugins.bundle.config", "plugins.row.config", "conversation.composer.dock"],
  },
];

let failed = 0;
for (const testCase of cases) {
  try {
    const mod = loadModule({ fetchImpl: testCase.options.failFetch ? undefined : () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }) });
    const { ctx, log } = makeCtx(testCase.options);
    mod.apply(ctx);
    const problems = [];
    if (JSON.stringify(log.injected) !== JSON.stringify(testCase.expectInjected)) {
      problems.push(`注入的槽位是 [${log.injected.join(", ")}]，期望 [${testCase.expectInjected.join(", ")}]`);
    }
    if (testCase.options.failFetch !== true) {
      // 只有槽位真的注入成功，才可能有 key 注册；注入失败时 0 个才是对的。
      const wantCells = log.injected.includes("plugins.bundle.config") ? 2 : 0;
      const gotCells = log.registered.filter((item) => item.startsWith("plugins.bundle.config#")).length;
      if (gotCells !== wantCells) problems.push(`bundle.config 注册了 ${gotCells} 个 key，期望 ${wantCells} 个`);
    }
    if (problems.length > 0) {
      failed += 1;
      console.log(`✗ ${testCase.name}\n   ${problems.join("\n   ")}`);
    } else {
      console.log(`✓ ${testCase.name}  (注入 ${log.injected.length} 个槽位，注册 ${log.registered.length} 个 key)`);
    }
  } catch (error) {
    failed += 1;
    console.log(`✗ ${testCase.name}\n   apply 抛异常：${error && error.message ? error.message : error}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n全部通过：apply 在任何槽位缺失/端点异常的情况下都不会把 DSH 弄到打不开。");
