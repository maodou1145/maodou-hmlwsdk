/**
 * config.json 加工
 *
 * 对应 Gradle 的两个 task：
 *   mergeProfile   —— 把 build.gradle 里的 SDK 版本、variant 信息合进 config.json
 *   processProfile —— 再加工一遍（实测只调整了键顺序，内容不变）
 *
 * 实测依据：apps/_empty/_empty
 *   源码 entry/src/main/config.json                690 B
 *   → merge_profile/debug/config.json             1064 B
 *   → process_profile/debug/normal/config.json    1064 B
 *   → js/debug/source/lite/config.json            1137 B（多了 iconId / labelId）
 */

/**
 * 合并阶段：注入 apiVersion、variant 开关、abilities 默认值
 *
 * @param {object} source 源码里的 config.json
 * @param {object} opts
 * @param {number} opts.compileSdkVersion   来自 build.gradle 的 ohos.compileSdkVersion
 * @param {number} opts.compatibleSdkVersion 来自 defaultConfig.compatibleSdkVersion
 * @param {number|null} [opts.apiVersionCode] Hvigor 工程的 SDK 版本编码整数（如 40000010）；
 *        给了就走新版 apiVersion 格式，不给则保持 Gradle 的裸数字格式
 * @param {string|null} [opts.compileSdkVersionStr] compileSdkVersion 字段值
 * @param {boolean} [opts.debug]            debug 变体时写 deviceConfig.default.debug = true
 * @param {string} [opts.releaseType]       默认 "Release"
 * @returns {object} 新的 config 对象（不改原对象）
 */
export function mergeProfile(source, opts) {
  const out = structuredClone(source);

  out.app ??= {};
  if (opts.apiVersionCode != null) {
    // API 8+ 的真机包用编码整数（4.0.0(10) → 40000010），写裸 10 会被设备当成
    // 远古 API 版本、兼容性校验失败。字段集合对照实测可装包。
    out.app.apiVersion = {
      compileSdkType: "HarmonyOS",
      compatible: opts.apiVersionCode,
      compileSdkVersion: opts.compileSdkVersionStr ?? String(opts.apiVersionCode),
      releaseType: opts.releaseType ?? "Release",
      target: opts.apiVersionCode
    };
    out.app.appEnvironments = [];
  } else {
    out.app.apiVersion = {
      compatible: opts.compatibleSdkVersion,
      target: opts.compileSdkVersion,
      releaseType: opts.releaseType ?? "Release"
    };
  }

  out.deviceConfig ??= {};
  if (opts.debug) {
    out.deviceConfig.default = {
      ...(out.deviceConfig.default ?? {}),
      debug: true
    };
  }

  if (opts.apiVersionCode != null) {
    // Hvigor 工程的 config.json 结构与 Gradle 不同：真机可装包都带
    // module.mainAbility / package / distroFilter，且 abilities 里没有 homeAbility。
    // 缺这些字段会在应用调测助手安装时报「40.配置文件格式错误」。
    const m = out.module ?? {};
    for (const ab of m.abilities ?? []) delete ab.homeAbility;
    // 源码里已经有值的字段一律沿用，缺了才补默认值 —— 这里不做覆盖。
    //   package      真包实测恒为 com.example.myapplication（与 app.bundleName 无关，
    //                GM星露谷/wanlian/自制 dice10 三个包都是这个值），但它是构建期
    //                占位符；工程自己写了就用工程的。
    //   mainAbility  与 abilities[0].name 同值，真包都是 .MainAbility。
    const known = ["deviceType", "abilities", "mainAbility", "distro", "distroFilter", "package", "js", "reqPermissions"];
    out.module = {
      deviceType: m.deviceType,
      abilities: m.abilities,
      mainAbility: m.mainAbility ?? m.abilities?.[0]?.name ?? ".MainAbility",
      distro: m.distro,
      distroFilter: m.distroFilter ?? {
        screenShape: { value: ["circle", "rect"], policy: "include" },
        screenWindow: { value: ["466*466", "408*480"], policy: "include" }
      },
      package: m.package ?? "com.example.myapplication",
      js: m.js,
      ...(m.reqPermissions ? { reqPermissions: m.reqPermissions } : {}),
      // 未知字段原样保留在末尾（不参与键序对照，我们的样例工程一个都没有）
      ...Object.fromEntries(Object.entries(m).filter(([k]) => !known.includes(k)))
    };
  } else {
    for (const ab of out.module?.abilities ?? []) {
      if (ab.homeAbility === undefined) ab.homeAbility = false;
    }
  }

  return out;
}

/**
 * 加工阶段：实测 gradle 只调整了键顺序，没有增删字段。
 *
 * 这里保留成独立函数，是因为后续如果要按 SDK 版本做字段迁移（比如 apiVersion
 * 的写法在更高 API 上不一样），改动应该落在这个位置。
 */
export function processProfile(config) {
  return structuredClone(config);
}

/**
 * 序列化。必须和 Gradle 的 Java 序列化器一致，否则产物差 98 B。
 *
 * 实测两个格式差异（devdemo release 的 config.json，Gradle 3422 B vs 我们 3324 B）：
 *
 * 1. 非 ASCII 字符转义。Gradle 写 "\u4f20\u611f\u5668..."，我们直接写中文。
 *    "传感器订阅功能" 7 个中文 = 21 字节，转义后 42 字节，4 处共差 84 B。
 *
 * 2. 空对象带换行。Gradle 写：
 *        "deviceConfig": {
 *
 *        },
 *    中间那行是「缩进 + 4 个空格」的空行。我们写的是 `"deviceConfig": {},`，差约 15 B。
 *
 * 84 + 15 ≈ 98 B，正好对上总差异。
 */
export function stringifyConfig(config) {
  return (
    JSON.stringify(config, null, 4)
      // 非 ASCII → \uXXXX（小写十六进制，与 Java 一致）
      .replace(/[^\x00-\x7F]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
      // 空对象展开成三行，中间是「当前缩进 + 4 空格」的空行
      .replace(
        /^(\s*)"([^"]+)": \{\}(,?)$/gm,
        (_, ind, key, comma) => `${ind}"${key}": {\n${ind}    \n${ind}}${comma}`
      )
  );
}

/**
 * 紧凑版序列化 —— 打进文件树形态 hap 的那个 config.json
 *
 * 实测（devdemo release）：hap 里的 config.json 是 1935 B 单行，
 * 而 source/lite 里的是 3422 B 缩进版。两者内容一样，只是排版不同。
 *
 * 单行版的格式特征是「冒号后一个空格、逗号后没有空格」：
 *   {"app": {"apiVersion": {"compatible": 3,"releaseType": "Release",...
 *
 * 那个 replace 只影响键值分隔符：JSON 字符串内部的引号一定会被转义成 \"，
 * 所以未转义的 `":` 只可能是「键结束 + 冒号」，不会误伤值里的内容。
 */
export function stringifyConfigMinified(config) {
  return JSON.stringify(config)
    .replace(/[^\x00-\x7F]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
    .replace(/":/g, '": ');
}
