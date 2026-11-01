import { legacyV1Schema } from '../../src/domain/legacy-v1.ts'

/** Own fictional roads added to an existing public test project. */
export function legacyRoadFixture(value: unknown) {
  const legacy = legacyV1Schema.parse(value)
  legacy.params.junc = [
    {
      id: 7,
      app: 'L',
      edge: 'down',
      d: 120,
      kind: 'road',
      name: 'Учебная ветвь Альфа',
      side: true,
      px: -211,
    },
    {
      id: 9,
      app: 'R',
      edge: 'up',
      d: 100,
      kind: 'yard',
      name: 'Учебный выезд Бета',
      side: false,
      px: 999,
    },
  ]
  legacy.params.tee = {
    on: true,
    app: 'R',
    d: 300,
    n1: 'Учебная ветвь Север',
    n2: 'Учебная ветвь Юг',
    px: 12,
  }
  const post = legacy.objects.find((object) => object.t === 'post')!
  if (post.t !== 'post') throw new Error('Expected public post fixture')
  legacy.objects.push(
    { ...post, id: 1001, signs: ['3.20', '1.25', '8.1.1#110'], jrep: 7, auto: 1 },
    { ...post, id: 1002, signs: ['1.25', '8.1.3#120'], jside: 7, vert: 1, auto: 1 },
    { ...post, id: 1003, signs: ['1.25'], tee: 1, vert: 1, auto: 1 },
  )
  legacy.nid = 2000
  return legacy
}
