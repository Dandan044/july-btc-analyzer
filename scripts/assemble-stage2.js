#!/usr/bin/env node
/**
 * assemble-stage2.js — 按 JSON 清单组装阶段二任务文件
 *
 * 用法:
 *   node scripts/assemble-stage2.js --profile alt|zhuang          # stdout
 *   node scripts/assemble-stage2.js --profile alt|zhuang --write  # 写文件
 *
 * 功能:
 *   1. 读取 manifest-{profile}.json 获取文件列表
 *   2. 读取 profiles/vars-{profile}.json 获取变量值
 *   3. 对每份模块文件做 {{var}} 替换和 {{#cond}}...{{/cond}} 条件处理
 *   4. 拼接输出
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let profile = null, doWrite = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile' && i + 1 < args.length) profile = args[++i];
  else if (args[i].startsWith('--profile=')) profile = args[i].split('=')[1];
  else if (args[i] === '--write') doWrite = true;
}
if (!profile || !['alt','zhuang'].includes(profile)) {
  console.error('Usage: node scripts/assemble-stage2.js --profile alt|zhuang [--write]');
  process.exit(1);
}

const pipelineDir = path.join(__dirname, '..', 'tasks', 'pipeline');

// 读清单
const manifestPath = path.join(pipelineDir, `manifest-${profile}.json`);
if (!fs.existsSync(manifestPath)) { console.error(`Missing: ${manifestPath}`); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

// 读变量
const varsPath = path.join(pipelineDir, 'profiles', `vars-${profile}.json`);
if (!fs.existsSync(varsPath)) { console.error(`Missing: ${varsPath}`); process.exit(1); }
const vars = JSON.parse(fs.readFileSync(varsPath, 'utf-8'));

// 替换函数
function applyVars(text) {
  // include 文件引用 {{include:name}} → 读取 profiles/name-{profile}.md
  text = text.replace(/\{\{include:(\w[\w-]*)\}\}/g, (_, name) => {
    const incPath = path.join(pipelineDir, 'profiles', `${name}-${profile}.md`);
    if (fs.existsSync(incPath)) return fs.readFileSync(incPath, 'utf-8').replace(/\n$/, '');
    console.error(`Include not found: profiles/${name}-${profile}.md`);
    return `{{include:${name}}}`;
  });

  // 条件块 {{#flag}}...{{/flag}}（flag 为 true/truthy 时保留内容）
  text = text.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, flag, body) => {
    return vars[flag] ? body : '';
  });

  // 简单变量替换 {{var}}
  text = text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key in vars) return String(vars[key]);
    return `{{${key}}}`;
  });

  return text;
}

// 组装
let assembled = '';
for (const file of manifest.files) {
  const fp = path.join(pipelineDir, file);
  if (!fs.existsSync(fp)) { console.error(`Missing: ${file}`); process.exit(1); }
  assembled += applyVars(fs.readFileSync(fp, 'utf-8'));
}

if (doWrite) {
  const header = [
    '# 阶段二任务书',
    '',
    `> 画像: ${vars.label} | 日志前缀: ${vars.log_prefix}`,
    '',
    `此文件由 assemble-stage2.js 按 manifest-${profile}.json 组装生成。`,
    '编辑请修改 modules/ 和 profiles/ 下的源文件，或调整清单与变量。',
    '',
    '---',
    ''
  ].join('\n');

  const outPath = path.join(pipelineDir, `stage2-${profile}.md`);
  fs.writeFileSync(outPath, (header + assembled).replace(/\n+$/, '\n'), 'utf-8');
  console.log(`Written: tasks/pipeline/stage2-${profile}.md (${assembled.length} chars)`);
} else {
  process.stdout.write(assembled.replace(/\n+$/, '\n'));
}
