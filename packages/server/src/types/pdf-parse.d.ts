/**
 * pdf-parse@1.1.1 无自带类型声明，这里补最小可用声明。
 *
 * 同时声明包根与 lib 子入口：
 * 实际使用的是 `pdf-parse/lib/pdf-parse.js`（包根 index.js 在 tsx/ESM-CJS 互操作下
 * 会误判 `!module.parent` 进入自测分支，去读自带的 test/data/05-versions-space.pdf 并抛 ENOENT）。
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  export interface PdfParseResult {
    /** 提取出的纯文本 */
    text: string;
    /** 页数 */
    numpages: number;
    /** 文档元信息 */
    info: Record<string, unknown> | null;
    /** pdf.js 元数据对象（可能为 null） */
    metadata: unknown;
    /** pdf.js 版本号 */
    version: string;
  }

  export interface PdfParseOptions {
    /** 只解析前 N 页 */
    max?: number;
    /** 自定义页渲染函数 */
    pagerender?: (pageData: unknown) => Promise<string> | string;
  }

  function pdfParse(data: Buffer | Uint8Array, options?: PdfParseOptions): Promise<PdfParseResult>;

  export default pdfParse;
}

declare module 'pdf-parse' {
  export interface PdfParseResult {
    /** 提取出的纯文本 */
    text: string;
    /** 页数 */
    numpages: number;
    /** 文档元信息 */
    info: Record<string, unknown> | null;
    /** 元数据（pdf.js 的 metadata 对象，可能为 null） */
    metadata: unknown;
    /** pdf.js 版本号 */
    version: string;
  }

  export interface PdfParseOptions {
    /** 只解析前 N 页 */
    max?: number;
    /** 解析到哪一页 */
    pagerender?: (pageData: unknown) => Promise<string> | string;
    /** 版本校验回调 */
    version?: string;
  }

  function pdfParse(
    data: Buffer | Uint8Array,
    options?: PdfParseOptions,
  ): Promise<PdfParseResult>;

  export default pdfParse;
}
