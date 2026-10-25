export class AmbiguousPu66Key extends Error {
  constructor() {
    super(
      'Ключ станционной карточки ПУ-66 устарел: на станции несколько карточек с этой привязкой. Привяжите проект к карточке заново.',
    )
  }
}
