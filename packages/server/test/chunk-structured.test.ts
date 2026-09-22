/**
 * 五期 §5.3 分块结构感知单测（chunkTextStructured 纯函数）。
 * 覆盖：标题切分 + sectionPath、标题栈（同级替换父级）、超长段二次切、无标题退化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkTextStructured } from '../src/util/text.ts';

test('标题切分 + sectionPath 正确', () => {
  const md = '# 一、概述\n\n这是概述内容。\n\n## 1.2 架构\n\n这里是架构细节内容。';
  const chunks = chunkTextStructured(md, { size: 700, overlap: 80 });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.sectionPath, '一、概述');
  assert.equal(chunks[1]?.sectionPath, '一、概述 > 1.2 架构');
  assert.ok(chunks[0]?.content.includes('这是概述内容'));
  assert.ok(chunks[1]?.content.includes('这里是架构细节内容'));
});

test('标题栈正确（同级标题替换父级）', () => {
  const md = '# 甲\n\n甲内容。\n\n# 乙\n\n乙内容。\n\n## 乙1\n\n乙1内容。';
  const chunks = chunkTextStructured(md, { size: 700 });

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.sectionPath, '甲');
  assert.equal(chunks[1]?.sectionPath, '乙');
  assert.equal(chunks[2]?.sectionPath, '乙 > 乙1');
});

test('超长段落二次切且全部携带章节路径、偏移单调不越界', () => {
  const long = '很长的一句话。'.repeat(300);
  const md = `# 章节\n\n${long}`;
  const chunks = chunkTextStructured(md, { size: 400, overlap: 80 });

  assert.ok(chunks.length > 1);
  let prevEnd = -1;
  for (const chunk of chunks) {
    assert.equal(chunk.sectionPath, '章节');
    assert.ok(chunk.charStart >= 0);
    assert.ok(chunk.charEnd <= md.length);
    assert.ok(chunk.charEnd > chunk.charStart);
    assert.ok(chunk.charStart >= prevEnd, '偏移应单调递增（允许重叠窗口重叠前段）');
    prevEnd = chunk.charStart;
  }
});

test('无标题文档退化为普通分块且无 sectionPath', () => {
  const plain = '普通段落，没有任何标题。'.repeat(50);
  const chunks = chunkTextStructured(plain, { size: 400, overlap: 80 });

  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) {
    assert.equal(chunk.sectionPath, undefined);
  }
});

test('固定长度模式不回退到句子边界', () => {
  const plain = `${'甲'.repeat(150)}。${'乙'.repeat(500)}。`;
  const sentenceChunks = chunkTextStructured(plain, { size: 200, overlap: 0, breakMode: 'sentence' });
  const fixedChunks = chunkTextStructured(plain, { size: 200, overlap: 0, breakMode: 'fixed' });
  assert.notEqual(sentenceChunks[0]?.charEnd, fixedChunks[0]?.charEnd);
  assert.equal(fixedChunks[0]?.charEnd, 200);
});

test('可关闭章节路径元数据', () => {
  const chunks = chunkTextStructured('# 标题\n\n正文内容。', { size: 400, preserveSectionPath: false });
  assert.equal(chunks[0]?.sectionPath, undefined);
  assert.ok(chunks[0]?.content.includes('正文内容'));
});
