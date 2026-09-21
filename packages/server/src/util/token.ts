/**
 * 字符启发式 token 估算（零新增依赖，不引 gpt-tokenizer）。
 *
 * 权威用量以厂商返回的 usage 为准；本估算仅用于预算预检与 UI 前置提示。
 * 规则（偏保守，宁可高估避免超上下文）：
 *   - CJK（中日韩 + 假名）≈ 1 token/字
 *   - Latin/数字 ≈ 4 字符/token
 *   - 其余可见标点 ≈ 1 token/字符；空白忽略
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/u;
const ALNUM = /[0-9A-Za-z]/;

/** 估算字符串的 token 数 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let alnum = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else if (ALNUM.test(ch)) alnum += 1;
    else if (!/\s/.test(ch)) other += 1;
  }
  return cjk + Math.ceil(alnum / 4) + other;
}

/** 估算一组消息（role+content）的总 token 数 */
export function estimateMessagesTokens(
  messages: readonly { role: string; content: string }[],
): number {
  let total = 0;
  for (const message of messages) {
    // 每条消息附加少量协议开销（role 标识 + 分隔符），保守计入
    total += estimateTokens(message.role) + estimateTokens(message.content) + 4;
  }
  return total;
}
