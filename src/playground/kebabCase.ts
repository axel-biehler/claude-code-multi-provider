export function kebabCase(input: string): string {
  return input.toLowerCase().trim().split(/\s+/).join('-')
}
