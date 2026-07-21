export function camelCase(input: string): string {
  const words = input.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return words.map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))).join('')
}
