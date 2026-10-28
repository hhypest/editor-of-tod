/** Minimal Vue host for rendered content/events; browser layout remains in Playwright. */
import {
  createRenderer,
  defineComponent,
  h,
  shallowReactive,
  type Component,
  type Plugin,
} from 'vue'

export type HostNode = {
  tag: string
  text: string
  props: Record<string, unknown>
  children: HostNode[]
  parent: HostNode | null
}
const host = (tag = '', text = ''): HostNode => ({
  tag,
  text,
  props: {},
  children: [],
  parent: null,
})
const renderer = createRenderer<HostNode, HostNode>({
  createElement: (tag) => host(tag),
  createText: (text) => host('#text', text),
  createComment: (text) => host('#comment', text),
  insert(node, parent, anchor) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  },
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.text = text
    node.children = []
  },
  patchProp: (node, key, _before, after) => {
    node.props[key] = after
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
})

export function renderComponent(
  component: Component,
  initialProps: Record<string, unknown>,
  plugin?: Plugin,
) {
  const props = shallowReactive({ ...initialProps })
  const root = host('root')
  const app = renderer.createApp(defineComponent({ setup: () => () => h(component, props) }))
  if (plugin) app.use(plugin)
  app.mount(root)
  return { root, props, unmount: () => app.unmount() }
}
export function nodes(root: HostNode, predicate: (node: HostNode) => boolean): HostNode[] {
  return [
    ...(predicate(root) ? [root] : []),
    ...root.children.flatMap((node) => nodes(node, predicate)),
  ]
}
export function content(root: HostNode): string {
  return root.tag === '#comment' ? '' : root.text + root.children.map(content).join('')
}
export async function dispatch(node: HostNode, name: string, event: unknown = {}) {
  const handler = node.props[name] as (value: unknown) => unknown
  return await handler(event)
}
