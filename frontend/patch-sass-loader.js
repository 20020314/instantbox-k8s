/*
 * 修 sass-loader@7.1.0 的坑：
 *
 *   const render = getRenderFuncFromSassImpl(options.implementation || require("node-sass"));
 *
 * - options.implementation 在 sass-loader 7.1.0 里并没有被接进这个函数（是个假开关）
 * - 所以只要没装 node-sass 就直接抛 "Install node-sass"
 * - 而 node-sass@4 在 Node >= 16 / Alpine musl 上根本编译不出来
 *
 * 这里改成：显式 implementation 优先 -> 否则 node-sass -> 否则 dart-sass。
 */
const fs = require('fs');

const FILE = 'node_modules/sass-loader/lib/loader.js';
const FROM = 'options.implementation || require("node-sass")';
const TO =
  'options.implementation || (function(){try{return require("node-sass")}catch(e){return require("sass")}})()';

let src;
try {
  src = fs.readFileSync(FILE, 'utf8');
} catch (e) {
  console.error('[patch] 找不到', FILE, '- 检查 node_modules 是否装好');
  process.exit(1);
}

if (src.includes(TO)) {
  console.log('[patch] 已经打过补丁，跳过');
  process.exit(0);
}
if (!src.includes(FROM)) {
  console.error('[patch] sass-loader 版本变了，源码里找不到目标语句:', FROM);
  process.exit(1);
}

fs.writeFileSync(FILE, src.replace(FROM, TO));
console.log('[patch] sass-loader -> dart-sass fallback 已生效');
