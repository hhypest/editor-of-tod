export class AmbiguousPu66Key extends Error {
  constructor() {
    super(
      'Ключ станционной карточки ПУ-66 устарел: на станции несколько карточек с этой привязкой. Привяжите проект к карточке заново.',
    )
  }
}

export class InvalidPu66Lifecycle extends Error {}

export class InvalidPu66Verification extends Error {
  constructor() {
    super('Дата сверки ПУ-66 не может быть в будущем.')
  }
}
