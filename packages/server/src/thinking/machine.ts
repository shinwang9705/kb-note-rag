/**
 * 深度思考轮次状态机（显式迁移表，无隐式 for 循环、无状态机库）。
 *
 * 迁移表一字不差照搬设计 §3.2.1：
 *
 * | 当前状态 | 事件 | 下一状态 | 副作用 |
 * | Idle | submit | Planning | 建 thinking_runs 行 |
 * | Planning | planReady | RoundRunning | 预算预检；构造首轮上下文 |
 * | RoundRunning | firstDelta | RoundStreaming | 推 round_started |
 * | RoundStreaming | delta | RoundStreaming | 推 round_delta（节流） |
 * | RoundStreaming | finish | RoundVerifying | 解析结构化产物 |
 * | RoundVerifying | artifactParsed | RoundDone | 立即持久化本轮 |
 * | RoundDone | evaluate | RoundRunning/Synthesizing | 见早停表 |
 * | RoundStreaming/Running | abort | Aborting→Aborted | controller.abort() |
 * | RoundFailed | degrade | Synthesizing | 用最后成功轮次作终稿 |
 * | Synthesizing | finalStreamed | Completed | 写 messages.content + 汇总 usage |
 */

export type ThinkingState =
  | 'Idle'
  | 'Planning'
  | 'RoundRunning'
  | 'RoundStreaming'
  | 'RoundVerifying'
  | 'RoundDone'
  | 'RoundFailed'
  | 'Aborting'
  | 'Aborted'
  | 'Synthesizing'
  | 'Completed';

export type ThinkingMachineEvent =
  | 'submit'
  | 'planReady'
  | 'firstDelta'
  | 'delta'
  | 'finish'
  | 'artifactParsed'
  | 'evaluate'
  | 'abort'
  | 'degrade'
  | 'finalStreamed'
  /** Aborting -> Aborted 的内部自动事件（表内 "Aborting→Aborted"） */
  | 'aborted';

export type TransitionEffect =
  | 'createRun'
  | 'preflightAndSeed'
  | 'emitRoundStarted'
  | 'emitDeltaThrottled'
  | 'parseArtifact'
  | 'persistRound'
  | 'evaluateEarlyStop'
  | 'signalAbort'
  | 'emitAborted'
  | 'useLastGood'
  | 'finalize';

export interface Transition {
  next: ThinkingState | '__computed__';
  effect: TransitionEffect;
}

/** 表内 RoundDone+evaluate 的下一状态由早停判定动态给出 */
export const COMPUTED_NEXT = '__computed__' as const;

export const TRANSITION_TABLE: Map<ThinkingState, Map<ThinkingMachineEvent, Transition>> = new Map([
  ['Idle', new Map([['submit', { next: 'Planning', effect: 'createRun' }]])],
  ['Planning', new Map([['planReady', { next: 'RoundRunning', effect: 'preflightAndSeed' }]])],
  [
    'RoundRunning',
    new Map([
      ['firstDelta', { next: 'RoundStreaming', effect: 'emitRoundStarted' }],
      ['abort', { next: 'Aborting', effect: 'signalAbort' }],
    ]),
  ],
  [
    'RoundStreaming',
    new Map([
      ['delta', { next: 'RoundStreaming', effect: 'emitDeltaThrottled' }],
      ['finish', { next: 'RoundVerifying', effect: 'parseArtifact' }],
      ['abort', { next: 'Aborting', effect: 'signalAbort' }],
    ]),
  ],
  ['RoundVerifying', new Map([['artifactParsed', { next: 'RoundDone', effect: 'persistRound' }]])],
  ['RoundDone', new Map([['evaluate', { next: COMPUTED_NEXT, effect: 'evaluateEarlyStop' }]])],
  ['RoundFailed', new Map([['degrade', { next: 'Synthesizing', effect: 'useLastGood' }]])],
  ['Aborting', new Map([['aborted', { next: 'Aborted', effect: 'emitAborted' }]])],
  ['Synthesizing', new Map([['finalStreamed', { next: 'Completed', effect: 'finalize' }]])],
  ['Aborted', new Map()],
  ['Completed', new Map()],
]);

/** 查表：返回迁移（含副作用名）；非法迁移返回 undefined */
export function transition(state: ThinkingState, event: ThinkingMachineEvent): Transition | undefined {
  return TRANSITION_TABLE.get(state)?.get(event);
}

export interface ThinkingMachine {
  readonly state: ThinkingState;
  /** 执行迁移并返回副作用名；无迁移返回 undefined（状态不变） */
  dispatch(event: ThinkingMachineEvent): TransitionEffect | undefined;
  /** 显式设置状态（用于 RoundDone+evaluate 的动态下一状态等） */
  forceState(next: ThinkingState): void;
}

/** 创建一个状态机实例（引擎驱动时跟踪当前状态） */
export function createThinkingMachine(initial: ThinkingState = 'Idle'): ThinkingMachine {
  let state: ThinkingState = initial;
  return {
    get state() {
      return state;
    },
    dispatch(event) {
      const entry = transition(state, event);
      if (!entry) return undefined;
      if (entry.next !== COMPUTED_NEXT) state = entry.next;
      return entry.effect;
    },
    forceState(next) {
      state = next;
    },
  };
}
