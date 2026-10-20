import type { Dialect } from './types';

/** 操作 URI 路径，保留远程工作区的协议和主机。 */
export function joinUri(base: string, relative: string): string {
  const uri = new URL(base);
  /** 保留已经编码的 URL 路径，避免空格变成重复编码。 */
  const encode = (segment: string): string => {
    try { return encodeURIComponent(decodeURIComponent(segment)); } catch { return encodeURIComponent(segment); }
  };
  uri.pathname = `${uri.pathname.replace(/\/$/, '')}/${relative.split('/').map(encode).join('/')}`;
  return new URL(uri.toString()).toString();
}

/** 返回文件或目录的父目录 URI。 */
export function parentUri(value: string): string {
  const uri = new URL(value);
  uri.pathname = uri.pathname.replace(/\/$/, '').replace(/\/[^/]*$/, '') || '/';
  return uri.toString();
}

/** 提取解码后的末级名称，用于扩展名和 Sass 默认命名空间。 */
export function baseName(value: string): string {
  return decodeURIComponent(new URL(value).pathname.split('/').pop() ?? '');
}

/** 根据文件扩展名区分方言，CSS 为兼容默认值。 */
export function dialectOf(uri: string): Dialect {
  const extension = baseName(uri).split('.').pop();
  return extension === 'scss' || extension === 'less' || extension === 'wxss' ? extension : 'css';
}

/** 只接受静态本地引用，不请求远程 URL 或解释插值路径。 */
export function isLocalReference(value: string): boolean {
  return !!value && !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(value) && !/[?#]|[#$@]\{|\\/.test(value);
}
