/**
 * 五期 QA 独立补充边界（严过关）：
 *  - chunkTextStructured：多级标题栈（跳级入栈/上级替换）、标题后无正文不产生空块
 *  - validateCitations：越界编号边界（n=1 上界）、[0] 与前导零不误报
 * 说明：这些是工程师既有单测未覆盖的边界，用于防止「rubber-stamp」式测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkTextStructured } from '../src/util/text.ts';
import { validateCitations } from '../src/service/chat.service.ts';

test('多级标题栈：跳级标题正确入栈、上级标题正确替换', () => {
  const md = '# 一\n\n一内容。\n\n### 1.2.3 细节\n\n三级内容。\n\n## 1.2\n\n二级内容。';
  const chunks = chunkTextStructured(md, { size: 700 });

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.sectionPath, '一');
  assert.equal(chunks[1]?.sectionPath, '一 > 1.2.3 细节');
  assert.equal(chunks[2]?.sectionPath, '一 > 1.2');
});

test('标题后无正文不产生空块（中间空标题段被跳过）', () => {
  const md = '# 甲\n\n# 乙\n\n乙内容。';
  const chunks = chunkTextStructured(md, { size: 700 });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.sectionPath, '乙');
  assert.ok(chunks[0]?.content.includes('乙内容'));
});

test('越界引用上界：sourceCount=1 时 [1] 合法、[2] 越界', () => {
  assert.deepEqual(validateCitations('见 [1]', 1), []);
  assert.deepEqual(validateCitations('见 [2]', 1), [2]);
});

test('引用编号 [0] 非法，前导零 [01] 仍合法', () => {
  // 编号必须从 1 开始
  assert.deepEqual(validateCitations('见 [0] 和 [1]', 3), [0]);
  // 前导零解析为数值 1，在范围内
  assert.deepEqual(validateCitations('见 [01]', 3), []);
});
