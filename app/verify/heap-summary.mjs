// The top constructors of a V8 .heapsnapshot by retained size, the way DevTools' Summary view ranks them. Plain Node, no dependencies.
//   node verify/heap-summary.mjs <file.heapsnapshot> [top]
// Retained size comes from a dominator tree (Cooper, Harvey, Kennedy) over the essential edges, as DevTools counts them: weak and
// shortcut edges are left out. A class's retained size adds only the instances not dominated by another instance of the same class,
// so a tree of nodes is not counted once per level.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const groupOf = (type, name) => {
  switch (type) {
    case 'object':
    case 'native':
      return name;
    case 'string':
    case 'concatenated string':
    case 'sliced string':
      return '(string)';
    case 'array':
      return '(array)';
    case 'closure':
      return '(closure)';
    case 'code':
      return '(compiled code)';
    case 'hidden':
    case 'synthetic':
      return '(system)';
    case 'number':
      return '(number)';
    default:
      return `(${type})`;
  }
};

export function summarize(file, top = 20) {
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  const { node_fields: nf, edge_fields: ef, node_types: nodeTypes, edge_types: edgeTypes } = snap.snapshot.meta;
  const N = nf.length;
  const E = ef.length;
  const nodes = snap.nodes;
  const edges = snap.edges;
  const strings = snap.strings;
  const nodeCount = nodes.length / N;
  const typeAt = nf.indexOf('type');
  const nameAt = nf.indexOf('name');
  const selfAt = nf.indexOf('self_size');
  const edgeCountAt = nf.indexOf('edge_count');
  const edgeTypeAt = ef.indexOf('type');
  const toAt = ef.indexOf('to_node');
  const weak = edgeTypes[0].indexOf('weak');
  const shortcut = edgeTypes[0].indexOf('shortcut');

  // The first edge of each node.
  const firstEdge = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) firstEdge[i + 1] = firstEdge[i] + nodes[i * N + edgeCountAt];

  // Predecessors over essential edges, as CSR arrays.
  const predCount = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) {
    for (let e = firstEdge[i]; e < firstEdge[i + 1]; e++) {
      const t = edges[e * E + edgeTypeAt];
      if (t === weak || t === shortcut) continue;
      predCount[edges[e * E + toAt] / N + 1]++;
    }
  }
  for (let i = 0; i < nodeCount; i++) predCount[i + 1] += predCount[i];
  const preds = new Uint32Array(predCount[nodeCount]);
  const fill = predCount.slice(0, nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    for (let e = firstEdge[i]; e < firstEdge[i + 1]; e++) {
      const t = edges[e * E + edgeTypeAt];
      if (t === weak || t === shortcut) continue;
      preds[fill[edges[e * E + toAt] / N]++] = i;
    }
  }

  // Post-order over essential edges from the root (node 0), without recursion.
  const order = new Int32Array(nodeCount).fill(-1);
  const post = new Uint32Array(nodeCount);
  let posted = 0;
  const visited = new Uint8Array(nodeCount);
  const stack = new Uint32Array(nodeCount);
  const cursor = new Uint32Array(nodeCount);
  let sp = 0;
  stack[sp++] = 0;
  visited[0] = 1;
  cursor[0] = firstEdge[0];
  while (sp) {
    const v = stack[sp - 1];
    if (cursor[v] < firstEdge[v + 1]) {
      const e = cursor[v]++;
      const t = edges[e * E + edgeTypeAt];
      if (t === weak || t === shortcut) continue;
      const w = edges[e * E + toAt] / N;
      if (!visited[w]) {
        visited[w] = 1;
        cursor[w] = firstEdge[w];
        stack[sp++] = w;
      }
    } else {
      sp--;
      order[v] = posted;
      post[posted++] = v;
    }
  }

  // Dominators, iterating in reverse post-order until nothing changes.
  const dom = new Int32Array(nodeCount).fill(-1);
  dom[0] = 0;
  const intersect = (a, b) => {
    while (a !== b) {
      while (order[a] < order[b]) a = dom[a];
      while (order[b] < order[a]) b = dom[b];
    }
    return a;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = posted - 2; k >= 0; k--) {
      const v = post[k];
      let next = -1;
      for (let p = predCount[v]; p < predCount[v + 1]; p++) {
        const u = preds[p];
        if (order[u] < 0 || dom[u] < 0) continue;
        next = next < 0 ? u : intersect(u, next);
      }
      if (next >= 0 && dom[v] !== next) {
        dom[v] = next;
        changed = true;
      }
    }
  }

  // Retained size: each node's own size added to its dominator's, children before parents.
  const retained = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) retained[i] = nodes[i * N + selfAt];
  for (let k = 0; k < posted - 1; k++) {
    const v = post[k];
    if (dom[v] >= 0 && dom[v] !== v) retained[dom[v]] += retained[v];
  }

  const group = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) group[i] = groupOf(nodeTypes[0][nodes[i * N + typeAt]], strings[nodes[i * N + nameAt]]);
  const classes = new Map();
  let total = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (order[i] < 0) continue;
    const g = group[i];
    const c = classes.get(g) ?? { constructor: g, count: 0, shallowBytes: 0, retainedBytes: 0 };
    classes.set(g, c);
    c.count++;
    c.shallowBytes += nodes[i * N + selfAt];
    total += nodes[i * N + selfAt];
    if (dom[i] < 0 || group[dom[i]] !== g || dom[i] === i) c.retainedBytes += retained[i];
  }
  const MIB = 1024 * 1024;
  const r2 = (n) => +(n / MIB).toFixed(2);
  return {
    file,
    nodes: nodeCount,
    reachableNodes: posted,
    totalMiB: r2(total),
    top: [...classes.values()]
      // The roots hold everything, so (system) would always rank first and say nothing.
      .filter((c) => c.constructor !== '(system)')
      .sort((a, b) => b.retainedBytes - a.retainedBytes)
      .slice(0, top)
      .map((c) => ({ constructor: c.constructor, count: c.count, shallowMiB: r2(c.shallowBytes), retainedMiB: r2(c.retainedBytes) })),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [, , file, top] = process.argv;
  if (!file) throw new Error('usage: node verify/heap-summary.mjs <file.heapsnapshot> [top]');
  const t0 = Date.now();
  const r = summarize(file, Number(top ?? 20));
  console.log(`${r.nodes} nodes, ${r.reachableNodes} reachable, ${r.totalMiB} MiB total (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const c of r.top) console.log(`${String(c.retainedMiB).padStart(9)} MiB retained  ${String(c.shallowMiB).padStart(9)} MiB shallow  ${String(c.count).padStart(9)}  ${c.constructor}`);
}
