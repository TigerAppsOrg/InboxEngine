/** Princeton LISTSERV lists InboxEngine knows how to read. Residential lists cross-post heavily. */
export const RESIDENTIAL_LISTSERVS = [
  'WHITMANWIRE',
  'BUTLERBUZZ',
  'ROCKYWIRE',
  'RE-INNFORMER',
  'MATHEYMAIL',
  'HUOHUB',
  'YEHYELLOWPAGES'
] as const;

export const DEFAULT_LISTSERVS = [...RESIDENTIAL_LISTSERVS, 'FREEFOOD'] as const;

export function isResidential(name: string): boolean {
  return (RESIDENTIAL_LISTSERVS as readonly string[]).includes(name.toUpperCase());
}

export function isValidListName(name: string): boolean {
  return /^[A-Z0-9_-]{2,40}$/.test(name);
}

export function listservLabel(name: string): string {
  if (name === 'FREEFOOD') return 'FreeFood';
  return name;
}
