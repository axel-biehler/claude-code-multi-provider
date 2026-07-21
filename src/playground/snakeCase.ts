export function snakeCase(input: string): string {
  return input.toLowerCase().trim().split(/\s+/).join('_')
}
