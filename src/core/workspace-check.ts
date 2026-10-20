import type { CheckFile, CheckFinding, CheckIssue, CheckOptions, CheckProvider, CheckResult, Diagnostic, TextRange, WorkspaceReader } from '../api';

/** 一次建立行起点，所有诊断复用同一份 UTF-16 位置索引。 */
function positions(text: string) {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  /** 二分定位保留 CRLF、中文及代理对的编辑器字符计数。 */
  return (offset: number) => {
    offset = Math.max(0, Math.min(text.length, offset));
    let low = 0, high = starts.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle]! <= offset) low = middle; else high = middle; }
    return { line: low, character: offset - starts[low]! };
  };
}

/** 有界逐文件检查共享诊断端口，部分结果必须保留明确的完成状态。 */
export async function checkWorkspace(reader: WorkspaceReader, supplied: readonly CheckFile[], providers: readonly CheckProvider[], options: CheckOptions): Promise<CheckResult> {
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(1, Math.min(100000, Math.floor(options.maxFiles!))) : 10000;
  const maxFindings = Number.isFinite(options.maxFindings) ? Math.max(1, Math.min(100000, Math.floor(options.maxFindings!))) : 50000;
  const files = [...new Map(supplied.map((file) => [file.uri, file])).values()];
  const findings: CheckFinding[] = [];
  const issues = new Map<string, CheckIssue>();
  let issueCharacters = 0, issuesTruncated = false;
  /** 未完成原因即时去重并限制体积，超限仍必须标记检查不完整。 */
  function addIssue(issue: CheckIssue): void {
    const key = JSON.stringify(issue);
    if (issues.has(key)) return;
    if (issues.size >= 1000 || issueCharacters + key.length > 2_000_000) { issuesTruncated = true; return; }
    issues.set(key, issue); issueCharacters += key.length;
  }
  const dependencies = new Map<string, string>();
  let checked = 0, skipped = 0, full = false;
  if (files.length > maxFiles) addIssue({ message: `文件数量超过检查上限 ${maxFiles}，未执行全部检查。` });
  for (const file of files.slice(0, maxFiles)) {
    if (options.cancellation.isCancellationRequested || full) break;
    const matching = providers.filter((provider) => provider.active() && provider.languages.includes(file.languageId));
    if (!matching.length) { skipped++; continue; }
    const own = reader.revision?.(file.uri);
    let snapshot: Awaited<ReturnType<WorkspaceReader['read']>>;
    try { snapshot = await reader.read(file.uri); }
    catch (error) { skipped++; addIssue({ uri: file.uri, message: `文件读取失败：${error instanceof Error ? error.message : String(error)}` }); continue; }
    if (options.cancellation.isCancellationRequested) break;
    if (!snapshot || snapshot.text.length > 2_000_000) { skipped++; addIssue({ uri: file.uri, message: snapshot ? '文件超过两百万字符上限，未检查。' : '文件不存在或无法读取，未检查。' }); continue; }
    const ready: { provider: CheckProvider; items: readonly Diagnostic[] }[] = [];
    const captured = new Map<string, string>();
    if (own !== undefined) captured.set(file.uri, own);
    let stable = true;
    const request = { document: { uri: file.uri, text: snapshot.text, languageId: file.languageId, version: snapshot.version ?? 0 }, offset: 0, cancellation: options.cancellation };
    for (const provider of matching) {
      if (options.cancellation.isCancellationRequested) break;
      if (!provider.active()) { addIssue({ uri: file.uri, provider: provider.name, message: '检查器已卸载，未完成此项检查。' }); continue; }
      try {
        const provide = () => provider.provide(request);
        const trace = () => reader.navigation ? reader.navigation.capture(provide) : Promise.resolve(provide()).then((value) => ({ value, steps: [] }));
        const result = reader.capture ? await reader.capture(trace) : { value: await trace(), dependencies: [] };
        for (const dependency of result.dependencies) {
          const previous = captured.get(dependency.uri);
          if (previous !== undefined && previous !== dependency.revision) stable = false;
          captured.set(dependency.uri, dependency.revision);
        }
        if (!provider.active()) { addIssue({ uri: file.uri, provider: provider.name, message: '检查器在执行期间卸载，结果已丢弃。' }); continue; }
        for (const step of result.value.steps) if (step.code === 'budget' || step.code === 'error') addIssue({ uri: file.uri, provider: provider.name, message: step.message });
        ready.push({ provider, items: result.value.value });
      } catch (error) { addIssue({ uri: file.uri, provider: provider.name, message: `检查器执行失败：${error instanceof Error ? error.message : String(error)}` }); }
    }
    if (options.cancellation.isCancellationRequested) break;
    if (reader.revision && [...captured].some(([uri, revision]) => reader.revision!(uri) !== revision)) stable = false;
    if (!stable) { skipped++; addIssue({ uri: file.uri, message: '读取期间文件或依赖发生变化，旧快照结果已丢弃。' }); continue; }
    for (const [uri, revision] of captured) {
      const before = dependencies.get(uri);
      if (before !== undefined && before !== revision) addIssue({ uri, message: '检查期间共享依赖发生变化，结果包含不同时间的快照。' });
      if (before === undefined) dependencies.set(uri, revision);
    }
    const position = positions(snapshot.text);
    const seen = new Set<string>();
    for (const { provider, items } of ready) for (const item of items) {
      if (options.severities?.length && !options.severities.includes(item.severity) || options.codes?.length && !options.codes.includes(item.code ?? '')) continue;
      const key = JSON.stringify([item.range.start, item.range.end, item.code, item.message, item.severity]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (findings.length >= maxFindings) { full = true; break; }
      const start = Math.max(0, Math.min(snapshot.text.length, Number.isFinite(item.range.start) ? item.range.start : 0));
      const range: TextRange = { start, end: Math.max(start, Math.min(snapshot.text.length, Number.isFinite(item.range.end) ? item.range.end : start)) };
      findings.push({ ...item, range, uri: file.uri, provider: provider.id, source: provider.name, position: { start: position(range.start), end: position(range.end) } });
    }
    checked++; options.progress?.(checked, Math.min(files.length, maxFiles), file);
  }
  if (full) addIssue({ message: `诊断数量达到 ${maxFindings} 条上限，后续结果未收集。` });
  if (reader.revision && [...dependencies].some(([uri, revision]) => reader.revision!(uri) !== revision)) addIssue({ message: '检查结束前源码或依赖发生变化，部分结果已过期。' });
  const report = { scopes: options.scopes ?? [], checkedAt: new Date().toISOString(), status: options.cancellation.isCancellationRequested ? 'cancelled' as const : issues.size || issuesTruncated || full ? 'incomplete' as const : 'complete' as const,
    selected: files.length, checked, skipped, findings, issues: [...issues.values(), ...issuesTruncated ? [{ message: '未完成原因超过一千条或两百万字符上限，后续原因未逐条保留。' }] : []] };
  return { report, dependencies: [...dependencies].map(([uri, revision]) => ({ uri, revision })) };
}
