import type { ReviewFinding } from '../../domain/review-scheme'

export type ReviewTarget = {
  view: 'source' | 'geometry' | 'objects' | 'review' | 'registries'
  sectionId:
    | 'details-title'
    | 'placements-title'
    | 'pu66-link-title'
    | 'imported-title'
    | 'review-title'
    | 'documents-title'
  field?: string
  registryTab?: 'imports' | 'documents'
}

/** UI destinations are independent of finding messages and persisted acknowledgment hashes. */
export function mapReviewTarget(
  finding: Pick<ReviewFinding, 'id' | 'path' | 'markBlocked'>,
): ReviewTarget {
  const { id, path } = finding
  if (id.startsWith('pdd-') && finding.markBlocked)
    return { view: 'registries', sectionId: 'documents-title', registryTab: 'documents' }
  if (path === 'crossing') return { view: 'source', sectionId: 'pu66-link-title' }
  if (path === 'placements') return { view: 'objects', sectionId: 'placements-title' }
  if (path === 'signImages')
    return { view: 'registries', sectionId: 'imported-title', registryTab: 'imports' }
  if (id === 'place' && path.startsWith('parameters.'))
    return { view: 'source', sectionId: 'details-title', field: path }
  if (path.startsWith('parameters.'))
    return { view: 'geometry', sectionId: 'details-title', field: path }
  if (path === 'parameters') return { view: 'geometry', sectionId: 'details-title' }
  if (path.startsWith('titleBlock.'))
    return { view: 'review', sectionId: 'details-title', field: path }
  return { view: 'review', sectionId: 'review-title' }
}
