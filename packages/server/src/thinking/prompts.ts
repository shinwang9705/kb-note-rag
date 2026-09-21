/**
 * sequential 顺序反思式 5 维度指令模板 + system prompt。
 *
 * 维度序列：①补充遗漏 → ②强化论据 → ③优化结构 → ④精简表达 → ⑤终稿收敛；
 * 首轮（index=1）= 给出完整初步回答。
 */

export const THINKING_SYSTEM_PROMPT = `你是深度思考引擎。请按顺序反思、逐轮迭代完善对问题的回答。每轮必须严格输出以下 XML 标签结构（标签名不可改动、不可省略）：

<outline>
- 要点一
- 要点二
</outline>

<changes>
- added|目标|说明
- reworded|目标|说明
</changes>

<score>
clarity: 8
coverage: 7
evidence: 7
concision: 8
</score>

<has_further_improvement>false</has_further_improvement>

<draft>
最终回答正文（完整地写在这里）
</draft>

其中 changes 的 type 只能取：added / removed / reworded / restructured / evidence_added / conclusion_changed；
每行格式为「type|目标|说明」。score 四项取 0-10 整数。has_further_improvement 为 true 或 false。`;

const DIMENSIONS: readonly string[] = [
  '基于上一轮回答进行「补充遗漏」：找出并补齐上一轮缺失的关键信息、边界条件或反例，给出更完整的回答。',
  '基于上一轮回答进行「强化论据」：为每个关键论点补充更充分的证据、数据或推理，使结论更有说服力。',
  '基于上一轮回答进行「优化结构」：调整段落顺序与逻辑层次，使回答条理清晰、层次分明。',
  '基于上一轮回答进行「精简表达」：删除冗余与重复，保留核心信息，使表达更简洁有力。',
  '进行「终稿收敛」：通读全篇，修正表述瑕疵，给出最终定稿。',
];

/** 第 index（1 起）轮的指令；超出 5 维度后持续「终稿收敛」 */
export function instructionForRound(index: number, totalRounds: number): string {
  void totalRounds;
  if (index <= 1) {
    return '给出该问题的完整初步回答。';
  }
  const dimIndex = index - 2; // 第 2 轮 -> 维度①
  if (dimIndex < DIMENSIONS.length) return DIMENSIONS[dimIndex] as string;
  return DIMENSIONS[DIMENSIONS.length - 1] as string;
}
