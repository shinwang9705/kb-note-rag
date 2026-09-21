/**
 * 五期 §5.4 引用编号回验单测（validateCitations 纯函数）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCitations } from '../src/service/chat.service.ts';

test('无 sources 时编号均非法', () => {
  assert.deepEqual(validateCitations('见 [1]', 0), [1]);
});

test('引用在范围内 -> 空数组', () => {
  assert.deepEqual(validateCitations('见 [1] 和 [3]', 3), []);
});

test('越界引用 -> 返回越界编号', () => {
  assert.deepEqual(validateCitations('见 [7]', 5), [7]);
});

test('多个越界引用去重且按出现顺序', () => {
  assert.deepEqual(validateCitations('见 [7] 和 [9] 和 [7]', 5), [7, 9]);
});

test('范围内外混合 -> 只报越界', () => {
  assert.deepEqual(validateCitations('见 [1] [5] [8]', 5), [8]);
});

test('非引用数字不受影响', () => {
  assert.deepEqual(validateCitations('共 2024 年，见 [3]', 2), [3]);
});

test('空答案 -> 空数组', () => {
  assert.deepEqual(validateCitations('', 5), []);
});
