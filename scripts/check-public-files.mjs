import { execFileSync } from 'node:child_process'

const tracked = execFileSync('git', ['ls-files', '-z']).toString('utf8').split('\0')
const prohibited = tracked.filter((path) =>
  /\.(?:xlsx?|sqlite(?:-wal|-shm|-journal)?|db|zip|png|jpe?g|pdf)$/i.test(path),
)

if (prohibited.length) {
  console.error(
    `Публичный репозиторий содержит ${prohibited.length} неподтверждённых бинарных материалов. Уберите их из Git перед PR.`,
  )
  process.exitCode = 1
} else {
  console.log('Публичный репозиторий не содержит рабочих книг, баз, архивов и изображений.')
}
