import { fileURLToPath, pathToFileURL } from 'node:url'
import { startApi } from './bootstrap.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databasePath =
    process.env.TOD_DATABASE_PATH ??
    fileURLToPath(new URL('../private-data/registry.sqlite', import.meta.url))
  startApi(databasePath)
}
