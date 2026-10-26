export class DocumentInUse extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentInUse'
  }
}
