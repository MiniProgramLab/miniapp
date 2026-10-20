/** 能力名称只影响文案；能力集合来自源码中的 LanguageFeatures 与 setup。 */
const featureLabels = { definition: '定义跳转', completion: '补全', hover: '悬浮', linkedEditing: '标签联动', autoInsertion: '自动闭合' };

/** 核心层使用稳定中文名称，新模块直接使用目录名称。 */
function label(name) {
  return ({ extension: '组合入口', api: '公共 API 与能力契约', core: '插件底座', resolution: '智能文件解析', 'adapters/vscode': 'VS Code / Cursor 适配器', 'languages/wxml': 'WXML', 'languages/css': 'CSS / WXSS / SCSS / Less', 'languages/typescript': 'TypeScript / JavaScript' })[name] ?? name.replace(/^npm:/, '').replace(/^languages\//, '');
}

/** 根据源码目录归入职责层；新语言、适配器及其他模块也会自动纳入图中。 */
function layerOf(name) {
  if (name === 'extension') return 0;
  if (name.startsWith('adapters/')) return 1;
  if (['api', 'core'].includes(name)) return 2;
  if (name.startsWith('languages/')) return 3;
  return 4;
}

/** 按传统架构图分层排列矩形模块，保留每条实际源码依赖。 */
export function layoutArchitecture(snapshot) {
  const components = [];
  const nodes = new Map();
  const boundaries = [];
  const externals = [...new Set(snapshot.dependencies.filter((edge) => edge.to.startsWith('npm:')).map((edge) => edge.to))].sort();
  const layers = [
    { label: '扩展装配层', type: 'cloud' },
    { label: '编辑器适配层', type: 'frontend' },
    { label: '公共契约与插件底座', type: 'cloud' },
    { label: '语言能力层', type: 'backend' },
    { label: '共享解析与工程服务', type: 'backend' },
    { label: '编辑器宿主与基础依赖', type: 'external' },
  ].map((layer, index) => ({ ...layer, names: index === 5 ? externals : snapshot.modules.filter((module) => layerOf(module.name) === index).map((module) => module.name) }));
  const maxColumns = Math.max(1, ...layers.map((layer) => Math.min(4, layer.names.length)));
  const cardWidth = Math.max(260, ...[...snapshot.modules.map((module) => module.name), ...externals].map((name) => [...label(name)].reduce((size, char) => size + (char.charCodeAt(0) > 255 ? 16 : 9), 32)));
  const gap = 36;
  const contentWidth = Math.max(1000, maxColumns * cardWidth + (maxColumns - 1) * gap);
  // 两侧留出独立连线通道，跨层依赖不穿过中间模块。
  const margin = 90 + snapshot.dependencies.length * 4;
  const width = contentWidth + margin * 2;
  let y = 116;
  let row = 0;

  for (const layer of layers) {
    if (!layer.names.length) continue;
    const columns = Math.min(layer.type === 'external' ? 3 : 4, layer.names.length);
    const nodeWidth = (contentWidth - (columns - 1) * gap) / columns;
    const firstRow = row;
    const wraps = [];
    layer.names.forEach((name, index) => {
      const module = snapshot.modules.find((item) => item.name === name);
      const capabilities = module?.features.map((feature) => featureLabels[feature] ?? feature) ?? [];
      const rowOffset = Math.floor(index / columns);
      const count = Math.min(columns, layer.names.length - rowOffset * columns);
      const startX = margin + (contentWidth - count * nodeWidth - (count - 1) * gap) / 2;
      const component = {
        id: `module${components.length}`, type: layer.type, label: label(name),
        pos: [startX + (index % columns) * (nodeWidth + gap), y + rowOffset * 210], size: [nodeWidth, 100],
        sublabel: capabilities.length > 3 ? `${capabilities.length} 项编辑能力` : capabilities.join(' · ') || (module ? `${module.exports.length} 个公开导出` : '外部运行时 / 类型依赖'),
        tag: name === 'extension' ? 'src/extension.ts · 注入依赖 · 注册插件 · 暴露 API' : name.startsWith('npm:') ? name.slice(4) : `src/${name}`,
      };
      components.push(component);
      nodes.set(name, { component, row: firstRow + rowOffset });
      wraps.push(component.id);
    });
    boundaries.push({ kind: 'region', label: layer.label, wraps, pad: 30 });
    const rows = Math.ceil(layer.names.length / columns);
    row += rows;
    y += rows * 210;
  }

  const connections = snapshot.dependencies.map((edge, index) => {
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    if (!source || !target) throw new Error(`未布局的架构依赖：${edge.from} → ${edge.to}`);
    const from = source.component;
    const to = target.component;
    const startX = from.pos[0] + from.size[0] / 2;
    const endX = to.pos[0] + to.size[0] / 2;
    const connection = { from: from.id, to: to.id, variant: edge.typeOnly ? 'dashed' : 'default' };
    // 同排相邻模块直接水平连接，其余依赖沿行间或外侧通道连接。
    if (source.row === target.row && Math.abs(startX - endX) <= from.size[0] + gap + 1) {
      const forward = startX < endX;
      return { ...connection, fromSide: forward ? 'right' : 'left', toSide: forward ? 'left' : 'right' };
    }
    if (target.row === source.row + 1) {
      const middleY = (from.pos[1] + from.size[1] + to.pos[1]) / 2;
      return { ...connection, fromSide: 'bottom', toSide: 'top', via: [[startX, middleY], [endX, middleY]] };
    }
    const offset = 35 + index % 8 * 5;
    const upward = target.row <= source.row;
    const channelX = edge.typeOnly || edge.to.startsWith('npm:') ? width - 30 - index * 4 : 30 + index * 4;
    const departureY = from.pos[1] + from.size[1] + offset;
    const arrivalY = upward ? to.pos[1] + to.size[1] + offset : to.pos[1] - offset;
    return { ...connection, fromSide: 'bottom', toSide: upward ? 'bottom' : 'top', via: [[startX, departureY], [channelX, departureY], [channelX, arrivalY], [endX, arrivalY]] };
  });
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'miniapp 插件分层架构', subtitle: `${snapshot.extension} · 箭头表示源码依赖方向 · 实线：运行时 · 虚线：仅类型`, viewBox: [width, y + 10] },
    components,
    boundaries,
    connections,
    cards: snapshot.modules.map((module) => ({
      dot: module.name.startsWith('languages/') ? 'emerald' : 'cyan',
      title: `${label(module.name)} · ${module.files.length} 个源文件`,
      items: [
        `目录：${module.name === 'extension' ? 'src/extension.ts' : `src/${module.name}`}`,
        `公开导出：${module.exports.join('、') || '无入口导出'}`,
        ...(module.features.length ? [`声明能力：${module.features.map((name) => featureLabels[name] ?? name).join('、')}`] : []),
        ...(module.ports.length ? [`依赖契约：${module.ports.join('、')}`] : []),
        ...module.resources.map((resource) => `语言资源：${resource}`),
      ],
    })),
  };
}
