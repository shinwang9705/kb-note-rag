/**
 * mammoth 无自带类型声明（且 @types/mammoth 非必需），这里补最小可用声明。
 * 只声明本项目实际用到的 API，避免引入不必要的依赖。
 */
declare module 'mammoth' {
  export interface MammothMessage {
    type: string;
    message: string;
  }

  export interface RawTextResult {
    /** 提取出的纯文本 */
    value: string;
    /** 转换过程中产生的告警信息 */
    messages: MammothMessage[];
  }

  export interface HtmlResult {
    value: string;
    messages: MammothMessage[];
  }

  export interface InputOptions {
    buffer?: Buffer;
    path?: string;
  }

  /** 抽取纯文本（本项目使用） */
  export function extractRawText(input: InputOptions): Promise<RawTextResult>;

  /** 转换为 HTML（保留更多结构，备用） */
  export function convertToHtml(input: InputOptions): Promise<HtmlResult>;

  const mammoth: {
    extractRawText: typeof extractRawText;
    convertToHtml: typeof convertToHtml;
  };

  export default mammoth;
}
