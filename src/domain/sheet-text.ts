/** Приблизительная ширина строки Arial: достаточно для переноса без измерения в браузере. */
export function textWidth(text: string, size: number): number {
  let units = 0
  for (const char of text) {
    if (char === ' ') units += 0.28
    else if ('.,:;!|il1()[]\'"«»'.includes(char)) units += 0.3
    else if (/[А-ЯЁA-ZШЩЖМЮ]/.test(char)) units += 0.68
    else if (/[0-9]/.test(char)) units += 0.556
    else units += 0.54
  }
  return units * size
}

/** Перенос по словам; слишком длинное слово переносится посимвольно. */
export function wrapText(text: string, width: number, size: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (textWidth(candidate, size) <= width) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      if (textWidth(word, size) <= width) {
        line = word
        continue
      }
      line = ''
      for (const char of word) {
        if (textWidth(line + char, size) > width && line) {
          lines.push(line)
          line = ''
        }
        line += char
      }
    }
    lines.push(line)
  }
  return lines
}
