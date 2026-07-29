export function resolveTemplate(template: string): string {
  return template.replace(/\{\{date}}/g, new Date().toISOString().split("T")[0]);
}
