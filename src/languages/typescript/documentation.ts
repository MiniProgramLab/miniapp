import ts from 'typescript';

/** 提取声明前的连续注释，保留中文说明与 JSDoc 标签。 */
export function documentation(node: ts.Node): string {
  const source = node.getSourceFile();
  // 紧跟对象左括号或逗号的注释被编译器归为尾注释，仍属于下一字段。
  const comments = [...ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [], ...ts.getTrailingCommentRanges(source.text, node.getFullStart()) ?? []]
    .filter((comment, index, all) => comment.end <= node.getStart() && all.findIndex((item) => item.pos === comment.pos) === index).sort((a, b) => a.pos - b.pos);
  return comments.map((comment) => source.text.slice(comment.pos, comment.end)
    .replace(/^\/\*+|\*\/$/g, '').replace(/^\s*(?:\*|\/\/) ?/gm, '').trim()).filter(Boolean).join('\n');
}

/** 名称和变量声明向所属语句取注释，成员不借用外层对象或相邻声明的说明。 */
export function declarationDocumentation(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current) && !ts.isBlock(current) && !ts.isObjectLiteralExpression(current); current = current.parent) {
    const description = documentation(current);
    if (description) return description;
    if (ts.isVariableStatement(current) || ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)
      || ts.isPropertyDeclaration(current) || ts.isPropertySignature(current) || ts.isFunctionLike(current)
      || ts.isEnumMember(current) || ts.isParameter(current) || ts.isBindingElement(current)) break;
  }
  return '';
}
