export type SheetNode =
  | {
      t: 'rect'
      x: number
      y: number
      w: number
      h: number
      fill?: string
      stroke?: string
      sw?: number
      rx?: number
    }
  | {
      t: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      stroke?: string
      sw?: number
      dash?: string
      arrows?: boolean
    }
  | { t: 'path'; d: string; fill?: string; stroke?: string; sw?: number }
  | {
      t: 'text'
      x: number
      y: number
      text: string
      size: number
      anchor?: 'start' | 'middle' | 'end'
      bold?: boolean
      italic?: boolean
      underline?: boolean
      fill?: string
      rotate?: number
      cls?: string
    }
  | { t: 'sign'; x: number; y: number; w: number; h: number; code: string }
  | { t: 'symbol'; id: 'cone' | 'reg' | 'truck'; x: number; y: number; w: number; h: number }
  | {
      t: 'group'
      objectId?: number
      roadNodeId?: number
      cls?: string
      box?: [number, number, number, number]
      children: SheetNode[]
    }
