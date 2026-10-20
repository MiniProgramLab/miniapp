import { anchor, polylinePath } from './vendor/archify/renderers/shared/geometry.mjs';
import { esc } from './vendor/archify/renderers/shared/utils.mjs';

/** 传统架构图沿用模板配色与导出功能，分层边框使用实线。 */
const traditionalStyle = `
    .c-region { fill: none; stroke: var(--lane-stroke); stroke-dasharray: none; }
    .t-cloud { fill: var(--text-muted); }
`;

/** 为矩形层图生成间距固定的中文图例，避免翻译后文字互相覆盖。 */
function legend(diagram) {
  const labels = { cloud: '装配与契约', frontend: '宿主适配', backend: '语言与解析', external: '外部依赖' };
  const types = [...new Set(diagram.components.map((component) => component.type))];
  const y = diagram.meta.viewBox[1] - 24;
  const parts = [`<text x="40" y="${y - 22}" class="t-primary" font-size="12" font-weight="600">图例</text>`];
  let x = 40;
  for (const type of types) {
    parts.push(`<rect x="${x}" y="${y - 11}" width="18" height="12" class="c-${type}" stroke-width="1"/>`);
    parts.push(`<text x="${x + 26}" y="${y}" class="t-muted" font-size="12">${labels[type] ?? esc(type)}</text>`);
    x += 160;
  }
  parts.push(`<path d="M ${x} ${y - 5} H ${x + 28}" class="a-default"/>`, `<text x="${x + 36}" y="${y}" class="t-muted" font-size="12">运行时依赖</text>`);
  parts.push(`<path d="M ${x + 170} ${y - 5} H ${x + 198}" class="a-dashed"/>`, `<text x="${x + 206}" y="${y}" class="t-muted" font-size="12">类型依赖</text>`);
  return parts.join('\n        ');
}

/** 只调整架构图的呈现；上游模板、交互及导出逻辑仍随项目交付。 */
export function traditionalArchitecture(html, diagram) {
  const nodes = new Map(diagram.components.map((component) => [component.id, { x: component.pos[0], y: component.pos[1], width: component.size[0], height: component.size[1], cx: component.pos[0] + component.size[0] / 2, cy: component.pos[1] + component.size[1] / 2 }]));
  let index = 0;
  const svg = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
  if (!svg) throw new Error('Archify 模板缺少 SVG，无法生成传统架构图。');
  const traditional = svg
    .replace(/<rect width="100%" height="100%" fill="url\(#grid\)"\s*\/>/, '')
    .replace(/rx="\d+"/g, 'rx="0"')
    .replace(/font-size="(7|8|9|11)"/g, (_match, size) => `font-size="${({ 7: 11, 8: 12, 9: 13, 11: 17 })[size]}"`)
    .replace('<!-- Boundaries (behind everything) -->', `<text x="40" y="32" class="t-primary" font-size="25" font-weight="600">${esc(diagram.meta.title)}</text>\n        <text x="40" y="56" class="t-muted" font-size="12">${esc(diagram.meta.subtitle)}</text>\n        <!-- 分层边界置于模块下方 -->`)
    // 精确使用原布局的锚点，将圆弧拐角转换成传统正交折线。
    .replace(/<path\b[^>]*class="a-(?:default|emphasis|dashed)"[^>]*\/>/g, (element) => {
      const connection = diagram.connections[index++];
      const from = anchor(nodes.get(connection.from), connection.fromSide ?? 'right');
      const to = anchor(nodes.get(connection.to), connection.toSide ?? 'left');
      const points = [from, ...(connection.via ?? []), to];
      if (!points.every((point) => point.every(Number.isFinite))) throw new Error('传统架构图包含无效的连线坐标。');
      return element.replace(/d="[^"]*"/, `d="${polylinePath(points)}"`);
    })
    .replace(/<!-- Legend -->[\s\S]*?<\/svg>/, `<!-- Legend -->\n        ${legend(diagram)}\n      </svg>`);
  if (index !== diagram.connections.length) throw new Error('Archify 连线结构已变化，请更新传统架构图转换逻辑。');
  return html.replace(svg, traditional)
    .replace('<html lang="en" data-theme="dark">', '<html lang="zh-CN" data-theme="light">')
    .replace(/font-family: 'JetBrains Mono'[^;]+;/, "font-family: Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif;")
    .replaceAll("window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'", "'light'")
    .replace('</style>', `${traditionalStyle}\n  </style>`);
}
